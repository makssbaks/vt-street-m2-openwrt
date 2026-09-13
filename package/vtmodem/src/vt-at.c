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
#ifndef LOCK_FILE
#define LOCK_FILE "/tmp/vtmodem-at.lock"
#endif

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/* All I/O, including lock contention, shares the caller's monotonic deadline. */
static int acquire_lock(long long deadline)
{
    int fd = open(LOCK_FILE, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (fd < 0) return -1;
    for (;;) {
        if (now_ms() >= deadline) { errno = ETIMEDOUT; break; }
        if (flock(fd, LOCK_EX | LOCK_NB) == 0) return fd;
        if (errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR) break;
        long long remain = deadline - now_ms();
        if (remain > 0) poll(NULL, 0, remain > 20 ? 20 : (int)remain);
    }
    int saved = errno;
    close(fd);
    errno = saved;
    return -1;
}

static int write_all(int fd, const char *buf, size_t len, long long deadline)
{
    while (len) {
        long long remain = deadline - now_ms();
        if (remain <= 0) { errno = ETIMEDOUT; return -1; }
        struct pollfd pfd = { .fd = fd, .events = POLLOUT };
        int pr = poll(&pfd, 1, (int)remain);
        if (pr < 0 && errno == EINTR) continue;
        if (pr <= 0) { if (!pr) errno = ETIMEDOUT; return -1; }
        if (!(pfd.revents & POLLOUT)) { errno = EIO; return -1; }
        ssize_t n = write(fd, buf, len);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n <= 0) { if (!n) errno = EIO; return -1; }
        buf += n;
        len -= (size_t)n;
    }
    return 0;
}

/* Ignore unterminated lines: even an incomplete "OK" is not confirmation. */
static int buffer_final(const char *buf, size_t len)
{
    size_t start = 0;
    for (size_t i = 0; i < len; i++) {
        if (buf[i] != '\r' && buf[i] != '\n') continue;
        size_t n = i - start;
        const char *line = buf + start;
        if (n == 2 && !memcmp(line, "OK", 2)) return 1;
        if ((n == 5 && !memcmp(line, "ERROR", 5)) ||
            (n >= 11 && (!memcmp(line, "+CME ERROR:", 11) ||
                         !memcmp(line, "+CMS ERROR:", 11)))) return 2;
        start = i + 1;
    }
    return 0;
}

static int transact(int fd, const char *cmd, char *out, size_t outsz,
                    long long deadline)
{
    char tx[512];
    size_t used = 0;
    out[0] = 0;
    int n = snprintf(tx, sizeof(tx), "%s\r", cmd);
    if (n <= 0 || (size_t)n >= sizeof(tx)) { errno = EINVAL; return 1; }
    if (write_all(fd, tx, (size_t)n, deadline) < 0)
        return errno == ETIMEDOUT ? 3 : 1;

    while (used + 1 < outsz) {
        long long remain = deadline - now_ms();
        if (remain <= 0) return 3;
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, (int)remain);
        if (pr < 0 && errno == EINTR) continue;
        if (pr < 0) return 1;
        if (!pr) return 3;
        if (!(pfd.revents & POLLIN)) { errno = EIO; return 1; }
        ssize_t r = read(fd, out + used, outsz - used - 1);
        if (r < 0 && (errno == EAGAIN || errno == EINTR)) continue;
        if (r <= 0) { errno = EIO; return 1; }
        used += (size_t)r;
        out[used] = 0;
        int final = buffer_final(out, used);
        if (final) return final == 1 ? 0 : 2;
    }
    errno = EMSGSIZE;
    return 4;
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

    if (strncmp(cmd, "AT", 2) || strpbrk(cmd, "\r\n")) {
        fprintf(stderr, "command must begin with AT\n");
        return 64;
    }

    long long deadline = now_ms() + timeout_ms;
    lockfd = acquire_lock(deadline);
    if (lockfd < 0) {
        int timed_out = errno == ETIMEDOUT;
        perror("modem lock");
        return timed_out ? 3 : 1;
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

    /* Echo is filtered below; avoid a separate configuration transaction. */
    memset(buf, 0, sizeof(buf));
    rc = transact(fd, cmd, buf, sizeof(buf), deadline);

    (void)tcsetattr(fd, TCSANOW, &oldtio);
    close(fd);
    close(lockfd);

    if (rc == 1) perror("AT transaction");
    else if (rc == 3) fprintf(stderr, "AT timeout without final result: %s\n", cmd);
    else if (rc == 4) fprintf(stderr, "AT response too large: %s\n", cmd);
    else (void)print_payload(buf, cmd);
    return rc;
}
