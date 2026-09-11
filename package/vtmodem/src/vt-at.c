#define _DEFAULT_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define DEFAULT_DEV "/dev/ttyACM0"
#define DEFAULT_TIMEOUT_MS 1500
#define MAX_TIMEOUT_MS 120000
#define BUF_SIZE 8192
#define LOCK_FILE "/tmp/vtmodem-at.lock"

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static int acquire_lock(void)
{
    int fd = open(LOCK_FILE, O_CREAT | O_RDWR, 0600);
    if (fd < 0)
        return -1;
    if (flock(fd, LOCK_EX) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static int write_all(int fd, const char *buf, size_t len)
{
    while (len) {
        ssize_t n = write(fd, buf, len);
        if (n < 0) {
            if (errno == EINTR || errno == EAGAIN)
                continue;
            return -1;
        }
        buf += n;
        len -= (size_t)n;
    }
    return 0;
}

static int line_is_final(const char *line)
{
    return !strcmp(line, "OK") || !strcmp(line, "ERROR") ||
           !strncmp(line, "+CME ERROR:", 11) ||
           !strncmp(line, "+CMS ERROR:", 11);
}

static int buffer_has_final(const char *buf, size_t len)
{
    char line[512];
    size_t lp = 0;

    for (size_t i = 0; i <= len; i++) {
        int sep = (i == len || buf[i] == '\r' || buf[i] == '\n');
        if (!sep) {
            if (lp + 1 < sizeof(line))
                line[lp++] = buf[i];
            continue;
        }
        if (lp) {
            line[lp] = 0;
            if (line_is_final(line))
                return 1;
            lp = 0;
        }
    }
    return 0;
}

static int transact(int fd, const char *cmd, char *out, size_t outsz,
                    int timeout_ms)
{
    char tx[512];
    size_t used = 0;
    int n = snprintf(tx, sizeof(tx), "%s\r", cmd);
    if (n <= 0 || (size_t)n >= sizeof(tx))
        return -1;

    if (write_all(fd, tx, (size_t)n) < 0)
        return -1;

    long long deadline = now_ms() + timeout_ms;

    while (now_ms() < deadline && used + 1 < outsz) {
        int remain = (int)(deadline - now_ms());
        if (remain < 1)
            remain = 1;

        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, remain);
        if (pr < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        if (pr == 0)
            break;

        if (pfd.revents & POLLIN) {
            ssize_t r = read(fd, out + used, outsz - used - 1);
            if (r > 0) {
                used += (size_t)r;
                out[used] = 0;
                if (buffer_has_final(out, used))
                    return 0;
            } else if (r < 0 && errno != EAGAIN && errno != EINTR) {
                return -1;
            }
        }
    }

    out[used] = 0;
    return used ? 0 : 1;
}

static int print_payload(const char *buf, const char *cmd)
{
    char line[1024];
    size_t lp = 0;
    int rc = 0;

    for (size_t i = 0;; i++) {
        char c = buf[i];
        int sep = (c == 0 || c == '\r' || c == '\n');

        if (!sep) {
            if (lp + 1 < sizeof(line))
                line[lp++] = c;
            continue;
        }

        if (lp) {
            line[lp] = 0;

            if (!strcmp(line, "OK")) {
                /* terminal success */
            } else if (!strcmp(line, "ERROR") ||
                       !strncmp(line, "+CME ERROR:", 11) ||
                       !strncmp(line, "+CMS ERROR:", 11)) {
                puts(line);
                rc = 2;
            } else if (strcmp(line, cmd) && strcmp(line, "ATE0")) {
                puts(line);
            }

            lp = 0;
        }

        if (c == 0)
            break;
    }

    return rc;
}

static void usage(const char *prog)
{
    fprintf(stderr,
            "usage: %s [-t timeout_ms] [device] 'AT+COMMAND'\n",
            prog);
}

int main(int argc, char **argv)
{
    const char *dev = DEFAULT_DEV;
    const char *cmd;
    struct termios oldtio, tio;
    char buf[BUF_SIZE];
    int fd, rc, lockfd;
    int timeout_ms = DEFAULT_TIMEOUT_MS;
    int argi = 1;

    if (argi < argc && !strcmp(argv[argi], "-t")) {
        char *end = NULL;
        long v;

        if (argi + 1 >= argc) {
            usage(argv[0]);
            return 64;
        }

        errno = 0;
        v = strtol(argv[argi + 1], &end, 10);
        if (errno || !end || *end || v < 100 || v > MAX_TIMEOUT_MS) {
            fprintf(stderr, "invalid timeout_ms (100-%d)\n", MAX_TIMEOUT_MS);
            return 64;
        }
        timeout_ms = (int)v;
        argi += 2;
    }

    if (argc - argi == 1) {
        cmd = argv[argi];
    } else if (argc - argi == 2) {
        dev = argv[argi];
        cmd = argv[argi + 1];
    } else {
        usage(argv[0]);
        return 64;
    }

    if (strncmp(cmd, "AT", 2)) {
        fprintf(stderr, "command must begin with AT\n");
        return 64;
    }

    lockfd = acquire_lock();
    if (lockfd < 0) {
        perror("modem lock");
        return 1;
    }

    fd = open(dev, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) {
        perror(dev);
        close(lockfd);
        return 1;
    }

    if (tcgetattr(fd, &oldtio) < 0) {
        perror("tcgetattr");
        close(fd);
        close(lockfd);
        return 1;
    }

    tio = oldtio;
    cfmakeraw(&tio);
    cfsetispeed(&tio, B115200);
    cfsetospeed(&tio, B115200);
    tio.c_cflag |= CLOCAL | CREAD;
#ifdef CRTSCTS
    tio.c_cflag &= ~CRTSCTS;
#endif
    tio.c_cc[VMIN] = 0;
    tio.c_cc[VTIME] = 0;

    if (tcsetattr(fd, TCSANOW, &tio) < 0) {
        perror("tcsetattr");
        close(fd);
        close(lockfd);
        return 1;
    }

    tcflush(fd, TCIOFLUSH);

    memset(buf, 0, sizeof(buf));
    (void)transact(fd, "ATE0", buf, sizeof(buf), DEFAULT_TIMEOUT_MS);
    tcflush(fd, TCIFLUSH);

    memset(buf, 0, sizeof(buf));
    rc = transact(fd, cmd, buf, sizeof(buf), timeout_ms);

    (void)tcsetattr(fd, TCSANOW, &oldtio);
    close(fd);
    close(lockfd);

    if (rc < 0) {
        perror("AT transaction");
        return 1;
    }
    if (rc > 0) {
        fprintf(stderr, "AT timeout: %s\n", cmd);
        return 3;
    }

    return print_payload(buf, cmd);
}
