#define _DEFAULT_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define DEFAULT_DEV "/dev/ttyUSB2"
#define IO_BUF 262144
#define SMS_TIMEOUT_MS 12000
#define SEND_TIMEOUT_MS 60000
#define MAX_PDU_BYTES 512
#define MAX_TEXT_BYTES 16384
#define MAX_MESSAGES 512

struct sms_msg {
    int id;
    char sender[96];
    char time[40];
    char text[MAX_TEXT_BYTES];
    int concat_ref;
    int concat_total;
    int concat_seq;
    int dcs;
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

static int write_all(int fd, const void *buf, size_t len)
{
    const uint8_t *p = buf;
    while (len) {
        ssize_t n = write(fd, p, len);
        if (n < 0) {
            if (errno == EINTR || errno == EAGAIN)
                continue;
            return -1;
        }
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

static int is_final_line(const char *line)
{
    return !strcmp(line, "OK") || !strcmp(line, "ERROR") ||
           !strncmp(line, "+CMS ERROR:", 11) ||
           !strncmp(line, "+CME ERROR:", 11);
}

static int has_final(const char *buf)
{
    const char *p = buf;
    char line[512];
    while (*p) {
        size_t n = 0;
        while (*p == '\r' || *p == '\n') p++;
        while (*p && *p != '\r' && *p != '\n' && n + 1 < sizeof(line))
            line[n++] = *p++;
        line[n] = 0;
        while (*p == '\r' || *p == '\n') p++;
        if (n && is_final_line(line))
            return 1;
    }
    return 0;
}

static int read_until(int fd, char *buf, size_t bufsz, const char *token,
                      int final_ok, int timeout_ms)
{
    size_t used = 0;
    long long deadline = now_ms() + timeout_ms;
    buf[0] = 0;

    while (now_ms() < deadline && used + 1 < bufsz) {
        int remain = (int)(deadline - now_ms());
        if (remain < 1) remain = 1;
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, remain);
        if (pr < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (pr == 0) break;
        if (!(pfd.revents & POLLIN)) continue;
        ssize_t r = read(fd, buf + used, bufsz - used - 1);
        if (r > 0) {
            used += (size_t)r;
            buf[used] = 0;
            if (token && strstr(buf, token))
                return 0;
            if (final_ok && has_final(buf))
                return 0;
        } else if (r < 0 && errno != EAGAIN && errno != EINTR) {
            return -1;
        }
    }
    return used ? 1 : 2;
}

static int at_cmd(int fd, const char *cmd, char *out, size_t outsz, int timeout_ms)
{
    char tx[256];
    int n = snprintf(tx, sizeof(tx), "%s\r", cmd);
    if (n <= 0 || (size_t)n >= sizeof(tx))
        return -1;
    tcflush(fd, TCIFLUSH);
    if (write_all(fd, tx, (size_t)n) < 0)
        return -1;
    int rc = read_until(fd, out, outsz, NULL, 1, timeout_ms);
    if (rc < 0) return rc;
    if (strstr(out, "ERROR") || strstr(out, "+CMS ERROR:") || strstr(out, "+CME ERROR:"))
        return -2;
    return rc == 2 ? -3 : 0;
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
    size_t cap = strlen(s) + 1;
    uint32_t *v = calloc(cap, sizeof(*v));
    if (!v) return -1;
    size_t n = 0;
    const unsigned char *p = (const unsigned char *)s;
    while (*p) {
        uint32_t cp;
        if (*p < 0x80) {
            cp = *p++;
        } else if ((*p & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) {
            cp = ((uint32_t)(p[0] & 0x1F) << 6) | (p[1] & 0x3F);
            if (cp < 0x80) goto bad;
            p += 2;
        } else if ((*p & 0xF0) == 0xE0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
            cp = ((uint32_t)(p[0] & 0x0F) << 12) | ((uint32_t)(p[1] & 0x3F) << 6) | (p[2] & 0x3F);
            if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) goto bad;
            p += 3;
        } else if ((*p & 0xF8) == 0xF0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80 && (p[3] & 0xC0) == 0x80) {
            cp = ((uint32_t)(p[0] & 0x07) << 18) | ((uint32_t)(p[1] & 0x3F) << 12) | ((uint32_t)(p[2] & 0x3F) << 6) | (p[3] & 0x3F);
            if (cp < 0x10000 || cp > 0x10FFFF) goto bad;
            p += 4;
        } else {
            goto bad;
        }
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
    if (need > cap || nd > 20) return 0;
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
    size_t pos = 0;
    if ((toa & 0x70) == 0x10 && pos + 1 < outsz) out[pos++] = '+';
    for (int i = 0; i < digits; i++) {
        uint8_t n = (i & 1) ? (p[i/2] >> 4) : (p[i/2] & 0xF);
        if (n <= 9 && pos + 1 < outsz) out[pos++] = (char)('0' + n);
    }
    if ((size_t)((digits + 1) / 2) > bytes) return -1;
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

static void parse_udh(const uint8_t *ud, size_t udlen, struct sms_msg *m)
{
    if (!udlen) return;
    size_t hdr = (size_t)ud[0] + 1;
    if (hdr > udlen) return;
    size_t p = 1;
    while (p + 1 < hdr) {
        uint8_t iei = ud[p++], len = ud[p++];
        if (p + len > hdr) break;
        if (iei == 0x00 && len == 3) {
            m->concat_ref = ud[p]; m->concat_total = ud[p+1]; m->concat_seq = ud[p+2];
        } else if (iei == 0x08 && len == 4) {
            m->concat_ref = ((int)ud[p] << 8) | ud[p+1];
            m->concat_total = ud[p+2]; m->concat_seq = ud[p+3];
        }
        p += len;
    }
}

static int decode_gsm_text(const uint8_t *ud, size_t udbytes, int udl, int udhi,
                           char *out, size_t outsz)
{
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
    if (pos < outsz) out[pos] = 0;
    return 0;
}

static int decode_ucs2_text(const uint8_t *p, size_t n, char *out, size_t outsz)
{
    size_t pos = 0;
    for (size_t i = 0; i + 1 < n; i += 2) {
        uint16_t w1 = ((uint16_t)p[i] << 8) | p[i+1];
        uint32_t cp = w1;
        if (w1 >= 0xD800 && w1 <= 0xDBFF && i + 3 < n) {
            uint16_t w2 = ((uint16_t)p[i+2] << 8) | p[i+3];
            if (w2 >= 0xDC00 && w2 <= 0xDFFF) {
                cp = 0x10000 + (((uint32_t)w1 - 0xD800) << 10) + ((uint32_t)w2 - 0xDC00);
                i += 2;
            }
        }
        pos = utf8_put(cp, out, pos, outsz);
    }
    if (pos < outsz) out[pos] = 0;
    return 0;
}

static int decode_deliver_pdu(const char *hex, struct sms_msg *m)
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
    int digits = b[p++];
    uint8_t toa = b[p++];
    size_t ab = (size_t)(digits + 1) / 2;
    if (p + ab + 2 + 7 + 1 > (size_t)n) return -1;
    if (decode_number(b + p, ab, digits, toa, m->sender, sizeof(m->sender)) < 0) return -1;
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
    if (udhi) parse_udh(ud, udbytes, m);

    if ((dcs & 0x0C) == 0x08) {
        size_t hb = 0;
        if (udhi) {
            if (!udbytes) return -1;
            hb = (size_t)ud[0] + 1;
            if (hb > udbytes) return -1;
        }
        size_t bytes = (size_t)udl;
        if (bytes > udbytes) bytes = udbytes;
        if (hb > bytes) return -1;
        return decode_ucs2_text(ud + hb, bytes - hb, m->text, sizeof(m->text));
    }
    if ((dcs & 0x0C) == 0x04) {
        snprintf(m->text, sizeof(m->text), "[8-bit SMS]");
        return 0;
    }
    return decode_gsm_text(ud, udbytes, udl, udhi, m->text, sizeof(m->text));
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
                msgs[count].id = pending_id;
                if (decode_deliver_pdu(line, &msgs[count]) == 0) count++;
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
        printf(",\"concat_ref\":%d,\"concat_total\":%d,\"concat_seq\":%d,\"dcs\":%d}",
               msgs[i].concat_ref, msgs[i].concat_total, msgs[i].concat_seq, msgs[i].dcs);
    }
    fputs("]}\n", stdout);
    free(msgs); free(buf);
    return 0;
}

static int delete_sms(const char *dev, int id)
{
    struct termios old;
    int fd = serial_open(dev,&old);
    if (fd < 0) { json_error(strerror(errno)); return 1; }
    char *buf = calloc(1, IO_BUF);
    if (!buf) { serial_close(fd,&old); json_error("out of memory"); return 1; }
    if (setup_sms(fd,buf) < 0) { free(buf); serial_close(fd,&old); json_error("SMS setup failed"); return 2; }
    char cmd[64]; snprintf(cmd,sizeof(cmd),"AT+CMGD=%d",id);
    int rc = at_cmd(fd,cmd,buf,IO_BUF,5000);
    serial_close(fd,&old); free(buf);
    if (rc < 0) { json_error("SMS delete failed"); return 2; }
    printf("{\"ok\":true,\"id\":%d}\n",id);
    return 0;
}

static int send_pdu(int fd, const uint8_t *pdu, size_t pdu_len, char *buf)
{
    char hex[MAX_PDU_BYTES*2 + 1], cmd[64];
    if (pdu_len < 2 || pdu_len > MAX_PDU_BYTES) return -1;
    hex_encode(pdu,pdu_len,hex,sizeof(hex));
    size_t smsc = pdu[0];
    if (1 + smsc >= pdu_len) return -1;
    int tpdu_len = (int)(pdu_len - 1 - smsc);
    snprintf(cmd,sizeof(cmd),"AT+CMGS=%d",tpdu_len);
    tcflush(fd,TCIFLUSH);
    char tx[80]; int n=snprintf(tx,sizeof(tx),"%s\r",cmd);
    if (write_all(fd,tx,(size_t)n)<0) return -1;
    int rr=read_until(fd,buf,IO_BUF,">",0,5000);
    if (rr < 0 || !strchr(buf,'>')) return -2;
    if (write_all(fd,hex,strlen(hex))<0) return -1;
    uint8_t z=0x1A;
    if (write_all(fd,&z,1)<0) return -1;
    rr=read_until(fd,buf,IO_BUF,NULL,1,SEND_TIMEOUT_MS);
    if (rr < 0 || strstr(buf,"ERROR") || strstr(buf,"+CMS ERROR:")) return -3;
    return strstr(buf,"OK") ? 0 : -4;
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

static int send_sms(const char *dev,const char *phone,const char *text)
{
    if(!phone||!*phone||!text) { json_error("phone and text are required"); return 64; }
    struct cpbuf cps={0}; if(utf8_decode_all(text,&cps)<0){json_error("invalid UTF-8");return 64;}
    struct septets gs={0}; int gr=encode_gsm7(&cps,&gs);
    int use_gsm=(gr==0);

    struct termios old; int fd=serial_open(dev,&old);
    if(fd<0){free(cps.v);free(gs.v);json_error(strerror(errno));return 1;}
    char *buf=calloc(1,IO_BUF); if(!buf){serial_close(fd,&old);free(cps.v);free(gs.v);json_error("out of memory");return 1;}
    if(at_cmd(fd,"ATE0",buf,IO_BUF,2000)<0 || at_cmd(fd,"AT+CMGF=0",buf,IO_BUF,2000)<0){free(buf);serial_close(fd,&old);free(cps.v);free(gs.v);json_error("SMS setup failed");return 2;}

    int sent=0,rc=0;
    uint8_t pdu[MAX_PDU_BYTES];
    if(use_gsm) {
        size_t lim=(gs.n<=160)?160:153;
        size_t parts=(gs.n+lim-1)/lim; if(parts==0) parts=1;
        size_t off=0;
        while(off<gs.n || (gs.n==0 && sent==0)) {
            size_t group_left=parts-(size_t)sent;
            int group_total=(int)(group_left>255?255:group_left);
            uint8_t ref=make_ref();
            for(int seq=1;seq<=group_total;seq++) {
                size_t take=gs.n-off; if(take>lim) take=lim;
                int mp=(parts>1);
                size_t pn=build_submit_gsm(phone,gs.v+off,take,mp,ref,group_total,seq,pdu,sizeof(pdu));
                if(!pn || send_pdu(fd,pdu,pn,buf)<0){rc=2;goto done;}
                off+=take; sent++;
                if(gs.n==0) break;
            }
        }
    } else {
        int units=count_ucs2_units(cps.v,cps.n);
        int lim=(units<=70)?70:67;
        size_t start=0;
        int total_parts=0; size_t t=start;
        while(t<cps.n || (cps.n==0&&total_parts==0)) {
            int used=0; size_t q=t;
            while(q<cps.n){int u=cps.v[q]>0xFFFF?2:1; if(used+u>lim)break; used+=u;q++;}
            total_parts++; t=q; if(cps.n==0)break;
        }
        size_t global_part=0; start=0;
        while(global_part<(size_t)total_parts) {
            int group_total=(int)((size_t)total_parts-global_part>255?255:(size_t)total_parts-global_part);
            uint8_t ref=make_ref();
            for(int seq=1;seq<=group_total;seq++) {
                int used=0; size_t end=start;
                while(end<cps.n){int u=cps.v[end]>0xFFFF?2:1; if(used+u>lim)break; used+=u;end++;}
                int mp=total_parts>1;
                size_t pn=build_submit_ucs2(phone,cps.v+start,end-start,mp,ref,group_total,seq,pdu,sizeof(pdu));
                if(!pn || send_pdu(fd,pdu,pn,buf)<0){rc=2;goto done;}
                start=end; global_part++; sent++;
                if(cps.n==0)break;
            }
        }
    }

done:
    serial_close(fd,&old); free(buf); free(cps.v); free(gs.v);
    if(rc){json_error("SMS send failed");return rc;}
    printf("{\"ok\":true,\"encoding\":\"%s\",\"segments\":%d}\n",use_gsm?"GSM-7":"UCS-2",sent);
    return 0;
}

static void usage(const char *p)
{
    fprintf(stderr,"usage: %s [-d device] list | delete <id> | send <phone> <text>\n",p);
}

int main(int argc,char **argv)
{
    const char *dev=DEFAULT_DEV; int a=1;
    if(a<argc && !strcmp(argv[a],"-d")) { if(a+1>=argc){usage(argv[0]);return 64;} dev=argv[a+1]; a+=2; }
    if(a>=argc){usage(argv[0]);return 64;}
    if(!strcmp(argv[a],"list") && a+1==argc) return list_sms(dev);
    if(!strcmp(argv[a],"delete") && a+2==argc) { char *e=NULL; long id=strtol(argv[a+1],&e,10); if(!e||*e||id<0||id>65535){json_error("invalid id");return 64;} return delete_sms(dev,(int)id); }
    if(!strcmp(argv[a],"send") && a+3==argc) return send_sms(dev,argv[a+1],argv[a+2]);
    usage(argv[0]); return 64;
}
