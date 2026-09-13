#define _DEFAULT_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define DEFAULT_DEV "/dev/ttyUSB2"
#define IO_BUF 262144
#ifndef SMS_TIMEOUT_MS
#define SMS_TIMEOUT_MS 12000
#endif
#ifndef SEND_TIMEOUT_MS
#define SEND_TIMEOUT_MS 60000
#endif
#define MAX_PDU_BYTES 512
#define MAX_TEXT_BYTES 16384
#define MAX_MESSAGES 512
#define MAX_OPERATION_MS 600000
#ifndef LOCK_FILE
#define LOCK_FILE "/tmp/vtmodem-at.lock"
#endif

static long long operation_deadline;

struct sms_msg {
    int id;
    char sender[96];
    char time[40];
    char text[MAX_TEXT_BYTES];
    int concat_ref;
    int concat_total;
    int concat_seq;
    int dcs;
    char fingerprint[MAX_PDU_BYTES * 2 + 1];
};

struct cpbuf {
    uint32_t *v;
    size_t n;
};

struct septets {
    uint8_t *v;
    size_t n;
};

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static long long command_deadline(int timeout_ms)
{
    long long d = now_ms() + timeout_ms;
    return d < operation_deadline ? d : operation_deadline;
}

static int acquire_lock(void)
{
    int fd = open(LOCK_FILE, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (fd < 0) return -1;
    for (;;) {
        if (now_ms() >= operation_deadline) { errno = ETIMEDOUT; break; }
        if (flock(fd, LOCK_EX | LOCK_NB) == 0) return fd;
        if (errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR) break;
        long long remain = operation_deadline - now_ms();
        if (remain > 0) poll(NULL, 0, remain > 20 ? 20 : (int)remain);
    }
    int saved = errno;
    close(fd);
    errno = saved;
    return -1;
}

static int write_all(int fd, const void *buf, size_t len, long long deadline)
{
    const uint8_t *p = buf;
    while (len) {
        long long remain = deadline - now_ms();
        if (remain <= 0) { errno = ETIMEDOUT; return -1; }
        struct pollfd pfd = { .fd = fd, .events = POLLOUT };
        int pr = poll(&pfd, 1, (int)remain);
        if (pr < 0 && errno == EINTR) continue;
        if (pr <= 0) { if (!pr) errno = ETIMEDOUT; return -1; }
        if (!(pfd.revents & POLLOUT)) { errno = EIO; return -1; }
        ssize_t n = write(fd, p, len);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n <= 0) { if (!n) errno = EIO; return -1; }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

static int serial_open(const char *dev, struct termios *oldtio)
{
    struct termios tio;
    int fd = open(dev, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0)
        return -1;
    if (tcgetattr(fd, oldtio) < 0) {
        close(fd);
        return -1;
    }
    tio = *oldtio;
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
        close(fd);
        return -1;
    }
    tcflush(fd, TCIOFLUSH);
    return fd;
}

static void serial_close(int fd, const struct termios *oldtio)
{
    (void)tcsetattr(fd, TCSANOW, oldtio);
    close(fd);
}

/* 1: complete OK line, -2: complete modem error, 0: unfinished. */
static int final_result(const char *buf)
{
    const char *start = buf;
    for (const char *p = buf; *p; p++) {
        if (*p != '\r' && *p != '\n') continue;
        size_t n = (size_t)(p - start);
        if (n == 2 && !memcmp(start, "OK", 2)) return 1;
        if ((n == 5 && !memcmp(start, "ERROR", 5)) ||
            (n >= 11 && (!memcmp(start, "+CMS ERROR:", 11) ||
                         !memcmp(start, "+CME ERROR:", 11)))) return -2;
        start = p + 1;
    }
    return 0;
}

static int has_prompt(const char *buf)
{
    for (const char *p = buf; *p; p++)
        if (*p == '>' && (p == buf || p[-1] == '\r' || p[-1] == '\n')) return 1;
    return 0;
}

static int read_until(int fd, char *buf, size_t bufsz, int prompt,
                      long long deadline)
{
    size_t used = 0;
    buf[0] = 0;
    while (used + 1 < bufsz) {
        long long remain = deadline - now_ms();
        if (remain <= 0) return -3;
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, (int)remain);
        if (pr < 0 && errno == EINTR) continue;
        if (pr < 0) return -1;
        if (!pr) return -3;
        if (!(pfd.revents & POLLIN)) return -1;
        ssize_t r = read(fd, buf + used, bufsz - used - 1);
        if (r < 0 && (errno == EAGAIN || errno == EINTR)) continue;
        if (r <= 0) return -1;
        used += (size_t)r;
        buf[used] = 0;
        int result = final_result(buf);
        if (result == -2) return -2;
        if (prompt ? has_prompt(buf) : result == 1) return 0;
    }
    return -4;
}

static int at_cmd(int fd, const char *cmd, char *out, size_t outsz, int timeout_ms)
{
    char tx[256];
    int n = snprintf(tx, sizeof(tx), "%s\r", cmd);
    if (n <= 0 || (size_t)n >= sizeof(tx)) return -1;
    long long deadline = command_deadline(timeout_ms);
    tcflush(fd, TCIFLUSH);
    if (write_all(fd, tx, (size_t)n, deadline) < 0)
        return errno == ETIMEDOUT ? -3 : -1;
    return read_until(fd, out, outsz, 0, deadline);
}

static void json_string(const char *s)
{
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        switch (c) {
        case '"': fputs("\\\"", stdout); break;
        case '\\': fputs("\\\\", stdout); break;
        case '\b': fputs("\\b", stdout); break;
        case '\f': fputs("\\f", stdout); break;
        case '\n': fputs("\\n", stdout); break;
        case '\r': fputs("\\r", stdout); break;
        case '\t': fputs("\\t", stdout); break;
        default:
            if (c < 0x20) printf("\\u%04x", c);
            else putchar(c);
        }
    }
    putchar('"');
}

static void json_error(const char *msg)
{
    fputs("{\"ok\":false,\"error\":", stdout);
    json_string(msg ? msg : "error");
    fputs("}\n", stdout);
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static int hex_decode(const char *s, uint8_t *out, size_t outsz)
{
    size_t n = strlen(s);
    if ((n & 1) || n / 2 > outsz) return -1;
    for (size_t i = 0; i < n; i += 2) {
        int a = hexval(s[i]), b = hexval(s[i + 1]);
        if (a < 0 || b < 0) return -1;
        out[i / 2] = (uint8_t)((a << 4) | b);
    }
    return (int)(n / 2);
}

static void hex_encode(const uint8_t *in, size_t n, char *out, size_t outsz)
{
    static const char h[] = "0123456789ABCDEF";
    if (outsz < n * 2 + 1) {
        if (outsz) out[0] = 0;
        return;
    }
    for (size_t i = 0; i < n; i++) {
        out[i * 2] = h[in[i] >> 4];
        out[i * 2 + 1] = h[in[i] & 15];
    }
    out[n * 2] = 0;
}

static int utf8_decode_all(const char *s, struct cpbuf *out)
{
    size_t bytes_left = strlen(s);
    size_t cap = bytes_left + 1;
    uint32_t *v = calloc(cap, sizeof(*v));
    if (!v) return -1;
    size_t n = 0;
    const unsigned char *p = (const unsigned char *)s;
    while (bytes_left) {
        const unsigned char *start = p;
        uint32_t cp;
        if (*p < 0x80) {
            cp = *p++;
        } else if (bytes_left >= 2 && (*p & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) {
            cp = ((uint32_t)(p[0] & 0x1F) << 6) | (p[1] & 0x3F);
            if (cp < 0x80) goto bad;
            p += 2;
        } else if (bytes_left >= 3 && (*p & 0xF0) == 0xE0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
            cp = ((uint32_t)(p[0] & 0x0F) << 12) | ((uint32_t)(p[1] & 0x3F) << 6) | (p[2] & 0x3F);
            if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) goto bad;
            p += 3;
        } else if (bytes_left >= 4 && (*p & 0xF8) == 0xF0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80 && (p[3] & 0xC0) == 0x80) {
            cp = ((uint32_t)(p[0] & 0x07) << 18) | ((uint32_t)(p[1] & 0x3F) << 12) | ((uint32_t)(p[2] & 0x3F) << 6) | (p[3] & 0x3F);
            if (cp < 0x10000 || cp > 0x10FFFF) goto bad;
            p += 4;
        } else {
            goto bad;
        }
        bytes_left -= (size_t)(p - start);
        v[n++] = cp;
    }
    out->v = v;
    out->n = n;
    return 0;
bad:
    free(v);
    return -1;
}

static size_t utf8_put(uint32_t cp, char *out, size_t pos, size_t cap)
{
    if (cp <= 0x7F) {
        if (pos + 1 < cap) out[pos++] = (char)cp;
    } else if (cp <= 0x7FF) {
        if (pos + 2 < cap) {
            out[pos++] = (char)(0xC0 | (cp >> 6));
            out[pos++] = (char)(0x80 | (cp & 0x3F));
        }
    } else if (cp <= 0xFFFF) {
        if (pos + 3 < cap) {
            out[pos++] = (char)(0xE0 | (cp >> 12));
            out[pos++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            out[pos++] = (char)(0x80 | (cp & 0x3F));
        }
    } else if (cp <= 0x10FFFF) {
        if (pos + 4 < cap) {
            out[pos++] = (char)(0xF0 | (cp >> 18));
            out[pos++] = (char)(0x80 | ((cp >> 12) & 0x3F));
            out[pos++] = (char)(0x80 | ((cp >> 6) & 0x3F));
            out[pos++] = (char)(0x80 | (cp & 0x3F));
        }
    }
    return pos;
}

struct gsm_map { uint32_t cp; uint8_t code; uint8_t ext; };
static const struct gsm_map gsm_special[] = {
    { '@',0x00,0 },{ 0x00A3,0x01,0 },{ '$',0x02,0 },{ 0x00A5,0x03,0 },
    { 0x00E8,0x04,0 },{ 0x00E9,0x05,0 },{ 0x00F9,0x06,0 },{ 0x00EC,0x07,0 },
    { 0x00F2,0x08,0 },{ 0x00C7,0x09,0 },{ '\n',0x0A,0 },{ 0x00D8,0x0B,0 },
    { 0x00F8,0x0C,0 },{ '\r',0x0D,0 },{ 0x00C5,0x0E,0 },{ 0x00E5,0x0F,0 },
    { 0x0394,0x10,0 },{ '_',0x11,0 },{ 0x03A6,0x12,0 },{ 0x0393,0x13,0 },
    { 0x039B,0x14,0 },{ 0x03A9,0x15,0 },{ 0x03A0,0x16,0 },{ 0x03A8,0x17,0 },
    { 0x03A3,0x18,0 },{ 0x0398,0x19,0 },{ 0x039E,0x1A,0 },{ 0x00C6,0x1C,0 },
    { 0x00E6,0x1D,0 },{ 0x00DF,0x1E,0 },{ 0x00C9,0x1F,0 },{ 0x00A4,0x24,0 },
    { 0x00A1,0x40,0 },{ 0x00C4,0x5B,0 },{ 0x00D6,0x5C,0 },{ 0x00D1,0x5D,0 },
    { 0x00DC,0x5E,0 },{ 0x00A7,0x5F,0 },{ 0x00BF,0x60,0 },{ 0x00E4,0x7B,0 },
    { 0x00F6,0x7C,0 },{ 0x00F1,0x7D,0 },{ 0x00FC,0x7E,0 },{ 0x00E0,0x7F,0 },
    { 0x000C,0x0A,1 },{ '^',0x14,1 },{ '{',0x28,1 },{ '}',0x29,1 },
    { '\\',0x2F,1 },{ '[',0x3C,1 },{ '~',0x3D,1 },{ ']',0x3E,1 },
    { '|',0x40,1 },{ 0x20AC,0x65,1 }
};

static int gsm_encode_cp(uint32_t cp, uint8_t out[2])
{
    if ((cp >= 0x20 && cp <= 0x23) || (cp >= 0x25 && cp <= 0x3F) ||
        (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) {
        out[0] = (uint8_t)cp;
        return 1;
    }
    for (size_t i = 0; i < sizeof(gsm_special)/sizeof(gsm_special[0]); i++) {
        if (gsm_special[i].cp == cp) {
            if (gsm_special[i].ext) {
                out[0] = 0x1B;
                out[1] = gsm_special[i].code;
                return 2;
            }
            out[0] = gsm_special[i].code;
            return 1;
        }
    }
    return 0;
}

static uint32_t gsm_decode_code(uint8_t code, int ext)
{
    for (size_t i = 0; i < sizeof(gsm_special)/sizeof(gsm_special[0]); i++)
        if (gsm_special[i].ext == ext && gsm_special[i].code == code)
            return gsm_special[i].cp;
    if (!ext && ((code >= 0x20 && code <= 0x23) || (code >= 0x25 && code <= 0x3F) ||
                 (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)))
        return code;
    return 0xFFFD;
}

static int encode_gsm7(const struct cpbuf *cps, struct septets *s)
{
    size_t cap = cps->n * 2 + 1, n = 0;
    uint8_t *v = malloc(cap);
    if (!v) return -1;
    for (size_t i = 0; i < cps->n; i++) {
        uint8_t tmp[2];
        int k = gsm_encode_cp(cps->v[i], tmp);
        if (!k) { free(v); return 1; }
        for (int j = 0; j < k; j++) v[n++] = tmp[j];
    }
    s->v = v;
    s->n = n;
    return 0;
}

static void bit_set(uint8_t *buf, size_t bitpos, int val)
{
    if (val) buf[bitpos / 8] |= (uint8_t)(1u << (bitpos % 8));
}

static void pack_septets(uint8_t *buf, size_t start_bit, const uint8_t *s, size_t n)
{
    for (size_t i = 0; i < n; i++)
        for (int b = 0; b < 7; b++)
            bit_set(buf, start_bit + i * 7 + (size_t)b, (s[i] >> b) & 1);
}

static uint8_t unpack_septet(const uint8_t *buf, size_t buflen, size_t bitpos)
{
    uint8_t v = 0;
    for (int b = 0; b < 7; b++) {
        size_t p = bitpos + (size_t)b;
        if (p / 8 < buflen && (buf[p / 8] & (1u << (p % 8))))
            v |= (uint8_t)(1u << b);
    }
    return v;
}

static size_t bcd_number(uint8_t *out, size_t cap, const char *phone, int with_len)
{
    const char *p = phone;
    int intl = (*p == '+');
    if (intl) p++;
    size_t nd = strlen(p);
    for (size_t i = 0; i < nd; i++) if (!isdigit((unsigned char)p[i])) return 0;
    size_t need = (with_len ? 2 : 1) + (nd + 1) / 2;
    if (need > cap || !nd || nd > 20) return 0;
    size_t pos = 0;
    if (with_len) out[pos++] = (uint8_t)nd;
    out[pos++] = intl ? 0x91 : 0x81;
    for (size_t i = 0; i < nd; i += 2) {
        int a = p[i] - '0';
        int b = (i + 1 < nd) ? p[i + 1] - '0' : 0xF;
        out[pos++] = (uint8_t)(a | (b << 4));
    }
    return pos;
}

static int decode_number(const uint8_t *p, size_t bytes, int digits, uint8_t toa,
                         char *out, size_t outsz)
{
    if (digits < 0 || (size_t)((digits + 1) / 2) > bytes) return -1;
    size_t pos = 0;
    if ((toa & 0x70) == 0x10 && pos + 1 < outsz) out[pos++] = '+';
    for (int i = 0; i < digits; i++) {
        uint8_t n = (i & 1) ? (p[i/2] >> 4) : (p[i/2] & 0xF);
        if (n > 9 || pos + 1 >= outsz) return -1;
        out[pos++] = (char)('0' + n);
    }
    out[pos] = 0;
    return 0;
}

static int semi(uint8_t b) { return (b & 0x0F) * 10 + ((b >> 4) & 0x0F); }

static void decode_scts(const uint8_t *p, char *out, size_t outsz)
{
    int yy = semi(p[0]), mo = semi(p[1]), dd = semi(p[2]);
    int hh = semi(p[3]), mm = semi(p[4]), ss = semi(p[5]);
    snprintf(out, outsz, "20%02d-%02d-%02dT%02d:%02d:%02d", yy, mo, dd, hh, mm, ss);
}

static int parse_udh(const uint8_t *ud, size_t udlen, struct sms_msg *m)
{
    if (!udlen) return -1;
    size_t hdr = (size_t)ud[0] + 1;
    if (hdr > udlen) return -1;
    size_t p = 1;
    int concat_seen = 0;
    while (p < hdr) {
        if (p + 2 > hdr) return -1;
        uint8_t iei = ud[p++], len = ud[p++];
        if (p + len > hdr) return -1;
        if (iei == 0x00 || iei == 0x08) {
            if (concat_seen++ || len != (iei == 0x00 ? 3 : 4)) return -1;
            size_t q = p;
            m->concat_ref = ud[q++];
            if (iei == 0x08) m->concat_ref = (m->concat_ref << 8) | ud[q++];
            m->concat_total = ud[q++];
            m->concat_seq = ud[q];
            if (!m->concat_total || !m->concat_seq || m->concat_seq > m->concat_total)
                return -1;
        }
        p += len;
    }
    return 0;
}

static int decode_gsm_text(const uint8_t *ud, size_t udbytes, int udl, int udhi,
                           char *out, size_t outsz)
{
    if (udl < 0 || udl > 160 || ((size_t)udl * 7 + 7) / 8 > udbytes) return -1;
    size_t start_bit = 0;
    int header_septets = 0;
    if (udhi) {
        if (!udbytes) return -1;
        size_t hb = (size_t)ud[0] + 1;
        if (hb > udbytes) return -1;
        header_septets = (int)((hb * 8 + 6) / 7);
        start_bit = (size_t)header_septets * 7;
    }
    int count = udl - header_septets;
    if (count < 0) return -1;
    size_t pos = 0;
    int ext = 0;
    for (int i = 0; i < count; i++) {
        uint8_t s = unpack_septet(ud, udbytes, start_bit + (size_t)i * 7);
        if (!ext && s == 0x1B) { ext = 1; continue; }
        uint32_t cp = gsm_decode_code(s, ext);
        ext = 0;
        pos = utf8_put(cp, out, pos, outsz);
    }
    if (ext) return -1;
    if (pos < outsz) out[pos] = 0;
    return 0;
}

static int decode_ucs2_text(const uint8_t *p, size_t n, char *out, size_t outsz)
{
    if (n & 1) return -1;
    size_t pos = 0;
    for (size_t i = 0; i < n; i += 2) {
        uint16_t w1 = ((uint16_t)p[i] << 8) | p[i + 1];
        uint32_t cp = w1;
        if (w1 >= 0xD800 && w1 <= 0xDBFF) {
            if (i + 3 >= n) return -1;
            uint16_t w2 = ((uint16_t)p[i + 2] << 8) | p[i + 3];
            if (w2 < 0xDC00 || w2 > 0xDFFF) return -1;
            cp = 0x10000 + (((uint32_t)w1 - 0xD800) << 10) + (w2 - 0xDC00);
            i += 2;
        } else if (w1 >= 0xDC00 && w1 <= 0xDFFF) return -1;
        /* JSON strings cannot contain a literal C NUL; retain its presence visibly. */
        if (!cp) cp = 0xFFFD;
        pos = utf8_put(cp, out, pos, outsz);
    }
    if (pos < outsz) out[pos] = 0;
    return 0;
}

static int decode_deliver_pdu_inner(const char *hex, struct sms_msg *m)
{
    uint8_t b[MAX_PDU_BYTES];
    int n = hex_decode(hex, b, sizeof(b));
    if (n < 0 || n < 2) return -1;
    size_t p = 0;
    uint8_t smsc_len = b[p++];
    if (p + smsc_len >= (size_t)n) return -1;
    p += smsc_len;
    uint8_t fo = b[p++];
    if ((fo & 0x03) != 0x00) return -2;
    if (p + 2 > (size_t)n) return -1;
    int address_len = b[p++];
    if (address_len > 20) return -1;
    uint8_t toa = b[p++];
    size_t ab = (size_t)(address_len + 1) / 2;
    if (p + ab + 2 + 7 + 1 > (size_t)n) return -1;
    if ((toa & 0x70) == 0x50) {
        int septet_count = (address_len * 4) / 7;
        if (decode_gsm_text(b + p, ab, septet_count, 0, m->sender, sizeof(m->sender)) < 0)
            return -1;
    } else {
        if (decode_number(b + p, ab, address_len, toa, m->sender, sizeof(m->sender)) < 0)
            return -1;
    }
    p += ab;
    (void)b[p++];
    uint8_t dcs = b[p++];
    m->dcs = dcs;
    decode_scts(b + p, m->time, sizeof(m->time));
    p += 7;
    int udl = b[p++];
    if (p > (size_t)n) return -1;
    const uint8_t *ud = b + p;
    size_t udbytes = (size_t)n - p;
    int udhi = !!(fo & 0x40);
    int alphabet;
    if ((dcs & 0x80) == 0) {
        if (dcs & 0x20) return -1; /* Compressed content is not supported. */
        alphabet = dcs & 0x0C;
    } else if ((dcs & 0xF0) == 0xF0) alphabet = dcs & 4;
    else if ((dcs & 0xF0) == 0xE0) alphabet = 8;
    else if ((dcs & 0xE0) == 0xC0) alphabet = 0;
    else return -1;
    if (alphabet == 12) return -1;
    size_t required = alphabet == 0 ? ((size_t)udl * 7 + 7) / 8 : (size_t)udl;
    if (required > 140 || required != udbytes) return -1;
    if (udhi && parse_udh(ud, required, m) < 0) return -1;

    if (alphabet == 8) {
        size_t hb = 0;
        if (udhi) {
            if (!udbytes) return -1;
            hb = (size_t)ud[0] + 1;
            if (hb > udbytes) return -1;
        }
        size_t bytes = (size_t)udl;
        if (bytes > udbytes) return -1;
        if (hb > bytes) return -1;
        return decode_ucs2_text(ud + hb, bytes - hb, m->text, sizeof(m->text));
    }
    if (alphabet == 4) {
        snprintf(m->text, sizeof(m->text), "[8-bit SMS]");
        return 0;
    }
    return decode_gsm_text(ud, udbytes, udl, udhi, m->text, sizeof(m->text));
}

static int decode_deliver_pdu(const char *hex, struct sms_msg *m)
{
    struct sms_msg parsed = {0};
    int rc = decode_deliver_pdu_inner(hex, &parsed);
    if (rc) return rc;
    size_t len = strlen(hex);
    if (len >= sizeof(parsed.fingerprint)) return -1;
    for (size_t i = 0; i < len; i++) parsed.fingerprint[i] = (char)toupper((unsigned char)hex[i]);
    parsed.id = m->id;
    *m = parsed;
    return 0;
}

static int setup_sms(int fd, char *buf)
{
    if (at_cmd(fd, "ATE0", buf, IO_BUF, 2000) < 0) return -1;
    if (at_cmd(fd, "AT+CMGF=0", buf, IO_BUF, 2000) < 0) return -1;
    if (at_cmd(fd, "AT+CPMS=\"MT\"", buf, IO_BUF, 3000) < 0) {
        if (at_cmd(fd, "AT+CPMS=\"SM\"", buf, IO_BUF, 3000) < 0)
            return -1;
    }
    return 0;
}

static int list_sms(const char *dev)
{
    struct termios old;
    int fd = serial_open(dev, &old);
    if (fd < 0) { json_error(strerror(errno)); return 1; }
    char *buf = calloc(1, IO_BUF);
    if (!buf) { serial_close(fd,&old); json_error("out of memory"); return 1; }
    if (setup_sms(fd, buf) < 0 || at_cmd(fd, "AT+CMGL=4", buf, IO_BUF, SMS_TIMEOUT_MS) < 0) {
        free(buf); serial_close(fd,&old); json_error("SMS list failed"); return 2;
    }
    serial_close(fd,&old);

    struct sms_msg *msgs = calloc(MAX_MESSAGES, sizeof(*msgs));
    if (!msgs) { free(buf); json_error("out of memory"); return 1; }
    int count = 0, pending_id = -1;
    char *save = NULL;
    for (char *line = strtok_r(buf, "\r\n", &save); line; line = strtok_r(NULL, "\r\n", &save)) {
        while (*line == ' ' || *line == '\t') line++;
        if (!strncmp(line, "+CMGL:", 6)) {
            int id = -1;
            if (sscanf(line + 6, " %d", &id) == 1) pending_id = id;
            continue;
        }
        if (pending_id >= 0 && *line) {
            int allhex = 1;
            for (const char *q=line; *q; q++) if (!isxdigit((unsigned char)*q)) { allhex=0; break; }
            if (allhex && count < MAX_MESSAGES) {
                struct sms_msg candidate = { .id = pending_id };
                if (decode_deliver_pdu(line, &candidate) == 0) msgs[count++] = candidate;
                pending_id = -1;
            }
        }
    }

    fputs("{\"ok\":true,\"messages\":[", stdout);
    for (int i = 0; i < count; i++) {
        if (i) putchar(',');
        printf("{\"id\":%d,\"sender\":", msgs[i].id); json_string(msgs[i].sender);
        fputs(",\"time\":", stdout); json_string(msgs[i].time);
        fputs(",\"text\":", stdout); json_string(msgs[i].text);
        fputs(",\"fingerprint\":", stdout); json_string(msgs[i].fingerprint);
        printf(",\"concat_ref\":%d,\"concat_total\":%d,\"concat_seq\":%d,\"dcs\":%d}",
               msgs[i].concat_ref, msgs[i].concat_total, msgs[i].concat_seq, msgs[i].dcs);
    }
    fputs("]}\n", stdout);
    free(msgs); free(buf);
    return 0;
}

static void delete_result(int ok, int id, const char *error, const char *code, int unknown)
{
    printf("{\"ok\":%s,\"id\":%d,\"outcome_unknown\":%s", ok ? "true" : "false", id,
           unknown ? "true" : "false");
    if (error) { fputs(",\"error\":", stdout); json_string(error); }
    if (code) { fputs(",\"code\":", stdout); json_string(code); }
    fputs("}\n", stdout);
}

static int delete_sms(const char *dev, int id, const char *expected)
{
    uint8_t expected_bytes[MAX_PDU_BYTES];
    if (!expected || hex_decode(expected, expected_bytes, sizeof(expected_bytes)) < 2) {
        delete_result(0, id, "A valid expected PDU is required; refresh the inbox", "invalid_identity", 0);
        return 64;
    }
    struct termios old;
    int fd = serial_open(dev, &old);
    if (fd < 0) { delete_result(0, id, strerror(errno), "device_error", 0); return 1; }
    char *buf = calloc(1, IO_BUF);
    if (!buf) { serial_close(fd, &old); json_error("out of memory"); return 1; }
    int rc = 2, unknown = 0;
    const char *error = "SMS setup failed", *code = "setup_failed";
    if (setup_sms(fd, buf) < 0) goto done;
    char cmd[64];
    snprintf(cmd, sizeof(cmd), "AT+CMGR=%d", id);
    error = "Cannot verify the current SMS; refresh the inbox";
    code = "read_failed";
    if (at_cmd(fd, cmd, buf, IO_BUF, 5000) < 0) goto done;
    int header = 0, matches = 0;
    char *save = NULL;
    for (char *line = strtok_r(buf, "\r\n", &save); line; line = strtok_r(NULL, "\r\n", &save)) {
        while (*line == ' ' || *line == '\t') line++;
        if (!strncmp(line, "+CMGR:", 6)) { header = 1; continue; }
        if (!header || !*line) continue;
        uint8_t actual[MAX_PDU_BYTES];
        int n = hex_decode(line, actual, sizeof(actual));
        if (n < 0) continue;
        int en = hex_decode(expected, expected_bytes, sizeof(expected_bytes));
        matches = n == en && !memcmp(actual, expected_bytes, (size_t)n);
        break;
    }
    error = "The SMS slot has changed; refresh the inbox before deleting";
    code = "message_changed";
    if (!matches) goto done;
    snprintf(cmd, sizeof(cmd), "AT+CMGD=%d", id);
    int result = at_cmd(fd, cmd, buf, IO_BUF, 5000);
    if (result < 0) {
        error = "SMS deletion was not confirmed; refresh the inbox";
        code = result == -2 ? "modem_error" : "unconfirmed";
        unknown = result != -2;
        goto done;
    }
    rc = 0; error = NULL; code = NULL;
done:
    serial_close(fd, &old);
    free(buf);
    delete_result(rc == 0, id, error, code, unknown);
    return rc;
}

static void cancel_sms_input(int fd)
{
    const uint8_t esc = 0x1B;
    (void)write_all(fd, &esc, 1, command_deadline(100));
}

static int has_cmgs_reference(const char *buf)
{
    for (const char *p = buf; *p; p++) {
        if ((p == buf || p[-1] == '\r' || p[-1] == '\n') && !strncmp(p, "+CMGS:", 6)) {
            p += 6;
            while (*p == ' ') p++;
            if (isdigit((unsigned char)*p)) return 1;
        }
    }
    return 0;
}

static int send_pdu(int fd, const uint8_t *pdu, size_t pdu_len, char *buf, int *unknown)
{
    char hex[MAX_PDU_BYTES * 2 + 1], tx[80];
    *unknown = 0;
    if (pdu_len < 2 || pdu_len > MAX_PDU_BYTES) return -1;
    hex_encode(pdu, pdu_len, hex, sizeof(hex));
    size_t smsc = pdu[0];
    if (1 + smsc >= pdu_len) return -1;
    int n = snprintf(tx, sizeof(tx), "AT+CMGS=%d\r", (int)(pdu_len - 1 - smsc));
    /* Keep a short cancellation budget if the modem is left at its input prompt. */
    long long prompt_deadline = command_deadline(5000);
    if (prompt_deadline > operation_deadline - 100) prompt_deadline = operation_deadline - 100;
    tcflush(fd, TCIFLUSH);
    if (write_all(fd, tx, (size_t)n, prompt_deadline) < 0) return -1;
    int rr = read_until(fd, buf, IO_BUF, 1, prompt_deadline);
    if (rr < 0) { if (rr != -2) cancel_sms_input(fd); return rr; }
    long long write_deadline = command_deadline(5000);
    if (write_deadline > operation_deadline - 100) write_deadline = operation_deadline - 100;
    if (write_all(fd, hex, strlen(hex), write_deadline) < 0) { cancel_sms_input(fd); return -1; }
    uint8_t z = 0x1A;
    if (write_all(fd, &z, 1, write_deadline) < 0) { cancel_sms_input(fd); return -1; }
    *unknown = 1; /* From Ctrl-Z onward, a timeout cannot prove non-delivery. */
    rr = read_until(fd, buf, IO_BUF, 0, command_deadline(SEND_TIMEOUT_MS));
    if (rr == -2) { *unknown = 0; return rr; }
    if (rr < 0 || !has_cmgs_reference(buf)) return rr < 0 ? rr : -3;
    *unknown = 0;
    return 0;
}

static size_t build_submit_gsm(const char *phone, const uint8_t *sept, size_t sn,
                               int multipart, uint8_t ref, int total, int seq,
                               uint8_t *out, size_t cap)
{
    size_t p=0;
    if (cap<32) return 0;
    out[p++]=0;
    out[p++]=(uint8_t)(multipart?0x51:0x11);
    out[p++]=0;
    size_t nb=bcd_number(out+p,cap-p,phone,1); if(!nb) return 0; p+=nb;
    out[p++]=0;
    out[p++]=0;
    out[p++]=0xAA;
    if (!multipart) {
        out[p++]=(uint8_t)sn;
        size_t bytes=(sn*7+7)/8;
        if (p+bytes>cap) return 0;
        memset(out+p,0,bytes);
        pack_septets(out+p,0,sept,sn);
        p+=bytes;
    } else {
        int hs=7;
        out[p++]=(uint8_t)(hs+(int)sn);
        size_t bits=(size_t)hs*7+sn*7;
        size_t bytes=(bits+7)/8;
        if (p+bytes>cap) return 0;
        memset(out+p,0,bytes);
        out[p+0]=0x05; out[p+1]=0x00; out[p+2]=0x03; out[p+3]=ref; out[p+4]=(uint8_t)total; out[p+5]=(uint8_t)seq;
        pack_septets(out+p,(size_t)hs*7,sept,sn);
        p+=bytes;
    }
    return p;
}

static size_t cp_to_ucs2(const uint32_t *cp, size_t n, uint8_t *out, size_t cap)
{
    size_t p=0;
    for(size_t i=0;i<n;i++) {
        uint32_t c=cp[i];
        if(c<=0xFFFF) {
            if(p+2>cap) return 0;
            out[p++]=(uint8_t)(c>>8); out[p++]=(uint8_t)c;
        } else {
            if(p+4>cap) return 0;
            c-=0x10000;
            uint16_t hi=(uint16_t)(0xD800+(c>>10));
            uint16_t lo=(uint16_t)(0xDC00+(c&0x3FF));
            out[p++]=(uint8_t)(hi>>8); out[p++]=(uint8_t)hi;
            out[p++]=(uint8_t)(lo>>8); out[p++]=(uint8_t)lo;
        }
    }
    return p;
}

static size_t build_submit_ucs2(const char *phone, const uint32_t *cp, size_t ncp,
                                int multipart, uint8_t ref, int total, int seq,
                                uint8_t *out,size_t cap)
{
    size_t p=0;
    out[p++]=0; out[p++]=(uint8_t)(multipart?0x51:0x11); out[p++]=0;
    size_t nb=bcd_number(out+p,cap-p,phone,1); if(!nb) return 0; p+=nb;
    out[p++]=0; out[p++]=0x08; out[p++]=0xAA;
    uint8_t txt[280]; size_t tn=cp_to_ucs2(cp,ncp,txt,sizeof(txt)); if(!tn && ncp) return 0;
    size_t udn=tn+(multipart?6:0); if(udn>255||p+1+udn>cap) return 0;
    out[p++]=(uint8_t)udn;
    if(multipart) { out[p++]=0x05; out[p++]=0x00; out[p++]=0x03; out[p++]=ref; out[p++]=(uint8_t)total; out[p++]=(uint8_t)seq; }
    memcpy(out+p,txt,tn); p+=tn;
    return p;
}

static uint8_t make_ref(void)
{
    struct timespec ts; clock_gettime(CLOCK_REALTIME,&ts);
    return (uint8_t)((ts.tv_nsec ^ ts.tv_sec ^ getpid()) & 0xFF);
}

static int count_ucs2_units(const uint32_t *v,size_t n)
{
    int u=0; for(size_t i=0;i<n;i++) u += v[i] > 0xFFFF ? 2 : 1; return u;
}

static void send_result(int total, int confirmed, int failed, int unknown,
                        const char *encoding, const char *error)
{
    printf("{\"ok\":%s,\"parts_total\":%d,\"parts_confirmed\":%d,\"segments\":%d,"
           "\"failed_part\":", error ? "false" : "true", total, confirmed, confirmed);
    if (failed) printf("%d", failed); else fputs("null", stdout);
    printf(",\"outcome_unknown\":%s,\"encoding\":", unknown ? "true" : "false");
    json_string(encoding);
    if (error) { fputs(",\"error\":", stdout); json_string(error); }
    fputs("}\n", stdout);
}

static int send_sms(const char *dev, const char *phone, const char *text)
{
    if (!phone || !*phone || !text || !*text || strlen(text) >= MAX_TEXT_BYTES) {
        json_error("phone and nonempty text within the size limit are required"); return 64;
    }
    uint8_t phone_test[32];
    if (!bcd_number(phone_test, sizeof(phone_test), phone, 1)) { json_error("invalid phone"); return 64; }
    struct cpbuf cps = {0};
    if (utf8_decode_all(text, &cps) < 0) { json_error("invalid UTF-8"); return 64; }
    struct septets gs = {0};
    int gr = encode_gsm7(&cps, &gs);
    if (gr < 0) { free(cps.v); json_error("out of memory"); return 1; }
    int gsm = gr == 0;
    /* Record symbol boundaries before any modem write; escape/surrogate pairs stay together. */
    size_t boundaries[257] = {0};
    int total = 0;
    size_t pos = 0, count = gsm ? gs.n : cps.n;
    int limit = gsm ? (gs.n <= 160 ? 160 : 153) :
                      (count_ucs2_units(cps.v, cps.n) <= 70 ? 70 : 67);
    while (pos < count && total < 255) {
        size_t next = pos;
        if (gsm) {
            next = count - pos > (size_t)limit ? pos + (size_t)limit : count;
            if (next < count && gs.v[next - 1] == 0x1B) next--;
        } else {
            int units = 0;
            while (next < count) {
                int u = cps.v[next] > 0xFFFF ? 2 : 1;
                if (units + u > limit) break;
                units += u; next++;
            }
        }
        if (next == pos) break;
        boundaries[++total] = pos = next;
    }
    if (pos != count || !total) {
        free(cps.v); free(gs.v); json_error("SMS exceeds 255 segments"); return 64;
    }
    int confirmed = 0, unknown = 0, rc = 2;
    const char *error = "SMS setup failed";
    struct termios old;
    int fd = serial_open(dev, &old);
    char *buf = NULL;
    if (fd < 0) { error = "Cannot open modem"; goto done; }
    buf = calloc(1, IO_BUF);
    if (!buf) { error = "out of memory"; goto done; }
    if (at_cmd(fd, "ATE0", buf, IO_BUF, 2000) < 0 ||
        at_cmd(fd, "AT+CMGF=0", buf, IO_BUF, 2000) < 0) goto done;
    uint8_t ref = make_ref(), pdu[MAX_PDU_BYTES];
    for (int part = 0; part < total; part++) {
        size_t off = boundaries[part], take = boundaries[part + 1] - off;
        size_t pn = gsm ? build_submit_gsm(phone, gs.v + off, take, total > 1, ref, total,
                                          part + 1, pdu, sizeof(pdu)) :
                          build_submit_ucs2(phone, cps.v + off, take, total > 1, ref, total,
                                           part + 1, pdu, sizeof(pdu));
        error = "SMS send failed";
        if (!pn || send_pdu(fd, pdu, pn, buf, &unknown) < 0) goto done;
        confirmed++;
    }
    rc = 0; error = NULL;
done:
    if (fd >= 0) serial_close(fd, &old);
    free(buf); free(cps.v); free(gs.v);
    send_result(total, confirmed, rc ? confirmed + 1 : 0, unknown,
                gsm ? "GSM-7" : "UCS-2", error);
    return rc;
}

static void usage(const char *p)
{
    fprintf(stderr, "usage: %s [-d device] [-t total_timeout_ms] list | delete <id> <expected_pdu> | send <phone> <text>\n", p);
}

int main(int argc, char **argv)
{
    const char *dev = DEFAULT_DEV;
    int a = 1, timeout_ms = 0;
    while (a < argc && (!strcmp(argv[a], "-d") || !strcmp(argv[a], "-t"))) {
        if (a + 1 >= argc) { usage(argv[0]); return 64; }
        if (!strcmp(argv[a], "-d")) dev = argv[a + 1];
        else {
            char *end = NULL;
            errno = 0;
            long n = strtol(argv[a + 1], &end, 10);
            if (errno || !end || end == argv[a + 1] || *end || n < 100 || n > MAX_OPERATION_MS) {
                json_error("invalid total timeout"); return 64;
            }
            timeout_ms = (int)n;
        }
        a += 2;
    }
    if (a >= argc) { usage(argv[0]); return 64; }
    int is_send = !strcmp(argv[a], "send"), is_list = !strcmp(argv[a], "list");
    int is_delete = !strcmp(argv[a], "delete");
    if ((is_send && a + 3 != argc) || (is_list && a + 1 != argc) ||
        (is_delete && a + 3 != argc) || (!is_send && !is_list && !is_delete)) {
        json_error("invalid arguments; delete requires the expected PDU"); usage(argv[0]); return 64;
    }
    long id = 0;
    if (is_delete) {
        char *end = NULL;
        errno = 0;
        id = strtol(argv[a + 1], &end, 10);
        if (errno || !end || end == argv[a + 1] || *end || id < 0 || id > 65535) {
            json_error("invalid id"); return 64;
        }
    }
    if (!timeout_ms) timeout_ms = is_send ? 240000 : 20000;
    operation_deadline = now_ms() + timeout_ms;
    int lockfd = acquire_lock();
    if (lockfd < 0) { json_error("modem lock unavailable before deadline"); return 75; }
    int rc = is_send ? send_sms(dev, argv[a + 1], argv[a + 2]) :
             is_delete ? delete_sms(dev, (int)id, argv[a + 2]) : list_sms(dev);
    close(lockfd);
    return rc;
}
