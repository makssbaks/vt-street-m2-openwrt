#!/usr/bin/env python3
"""Fault-path regressions against the actual AT/SMS C sources; no physical modem."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'package/vtmodem/src'
VALID = '0000029121000862903141931200020041'
OTHER = '0000029121000862903141931200020042'
BAD = '004002912100086290314193120001050003090201'


def compile_c(source, output, *flags):
    subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-O2', '-Wall', '-Wextra',
                    '-Werror', '-I', str(SRC), *flags, str(source), '-o', str(output)], check=True)


def emulate(binary, args, responder, timeout=4):
    master, slave = pty.openpty()
    proc = subprocess.Popen([str(binary), '-d', os.ttyname(slave), *args]
                            if binary.name == 'vt-sms' else
                            [str(binary), '-t', '220', os.ttyname(slave), *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pending = b''
    in_pdu = False
    commands, pdus = [], []
    deadline = time.monotonic() + timeout
    try:
        while proc.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.02)
            if not ready:
                continue
            pending += os.read(master, 65536)
            while True:
                terminator = b'\x1a' if in_pdu else b'\r'
                if terminator not in pending:
                    break
                line, pending = pending.split(terminator, 1)
                kind = 'pdu' if in_pdu else 'command'
                (pdus if in_pdu else commands).append(line.decode())
                if not in_pdu and line.startswith(b'AT+CMGS='):
                    in_pdu = True
                elif in_pdu:
                    in_pdu = False
                reply = responder(kind, line.decode(), commands, pdus)
                if reply:
                    os.write(master, reply)
        if proc.poll() is None:
            raise AssertionError(f'Operation exceeded test deadline: {commands}')
        out, err = proc.communicate(timeout=1)
        return proc.returncode, out.decode(), err.decode(), commands, pdus
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate()
        os.close(master)
        os.close(slave)


def sms_reply(kind, line, commands, pdus):
    if kind == 'pdu':
        return b'\r\n+CMGS: 31\r\nOK\r\n'
    if line.startswith('AT+CMGS='):
        return b'\r\n> '
    return b'\r\nOK\r\n'


def run():
    with tempfile.TemporaryDirectory(prefix='vt-c-tests-') as tmp:
        tmp = Path(tmp)
        lock = tmp / 'at.lock'
        lockflag = '-DLOCK_FILE="' + str(lock) + '"'
        at, sms = tmp / 'vt-at', tmp / 'vt-sms'
        compile_c(SRC / 'vt-at.c', at, lockflag)
        compile_c(SRC / 'vt-sms.c', sms, lockflag, '-DSEND_TIMEOUT_MS=220')

        # Terminal result framing and partial answers, including an unterminated OK.
        for payload, expected in [(b'\r\n^SLMODE:1,2\r\n', 3), (b'\r\nOK', 3),
                                  (b'\r\nERROR\r\n', 2),
                                  (b'AT^SLMODE?\r\r\n^SLMODE:1,2\r\nOK\r\n', 0)]:
            result = emulate(at, ['AT^SLMODE?'], lambda *_: payload)
            assert result[0] == expected, result
            if expected == 3:
                assert not result[1], 'Incomplete payload must not look like telemetry'

        # Lock contention is included in both programs' total operation deadline.
        with lock.open('w') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            for args in [[str(at), '-t', '150', '/dev/not-opened', 'AT'],
                         [str(sms), '-t', '150', '-d', '/dev/not-opened', 'list']]:
                begin = time.monotonic()
                p = subprocess.run(args, capture_output=True, timeout=1)
                elapsed = time.monotonic() - begin
                assert p.returncode != 0 and 0.10 < elapsed < 0.8, (p, elapsed)

        # PDU parsing: reject truncation, invalid UDH and invalid UTF16; no stale concat state.
        harness = tmp / 'sms-unit.c'
        harness.write_text(r'''
#define main vt_sms_main
#include "vt-sms.c"
#undef main
#include <assert.h>
#include <sys/socket.h>
int main(void) {
    struct sms_msg m = { .id = 7 };
    assert(decode_deliver_pdu("00000291210000629031419312000541", &m) < 0);
    assert(decode_deliver_pdu("004002912100086290314193120001050003090201", &m) < 0);
    assert(!m.concat_ref && !m.concat_total && !m.concat_seq);
    assert(decode_deliver_pdu("0000029121000862903141931200020041", &m) == 0);
    assert(!strcmp(m.text, "A") && m.id == 7 && !m.concat_total);
    assert(decode_deliver_pdu("000002912100086290314193120002D800", &m) < 0);
    assert(decode_deliver_pdu("000002912100086290314193120002DC00", &m) < 0);
    assert(decode_deliver_pdu("00000291210008629031419312000100", &m) < 0);
    assert(decode_deliver_pdu("000002912100086290314193120004D83DDE00", &m) == 0);
    assert(!strcmp(m.text, "\xF0\x9F\x98\x80"));
    struct cpbuf cps = {0};
    assert(utf8_decode_all("\xF0", &cps) < 0);
    assert(utf8_decode_all("\xE0\x80", &cps) < 0);
    assert(utf8_decode_all("\xED\xA0\x80", &cps) < 0);
    /* Preserve alphanumeric sender support from the original patch. */
    uint8_t pdu[64] = {0,0,6,0xd0};
    const uint8_t sender[] = {'A','B','C'};
    pack_septets(pdu + 4, 0, sender, 3);
    const uint8_t tail[] = {0,8,0x62,0x90,0x31,0x41,0x93,0x12,0,2,0,0x41};
    memcpy(pdu + 7, tail, sizeof(tail));
    char hex[129]; hex_encode(pdu, 7 + sizeof(tail), hex, sizeof(hex));
    assert(decode_deliver_pdu(hex, &m) == 0 && !strcmp(m.sender, "ABC"));
    /* Invalid IEs cannot be silently ignored or contaminate a later SMS. */
    uint8_t bad_ie[] = {5,0,3,9,2,0};
    assert(parse_udh(bad_ie, sizeof(bad_ie), &m) < 0);
    int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    assert(fcntl(pair[0], F_SETFL, O_NONBLOCK) == 0);
    char full[8192] = {0};
    while (write(pair[0], full, sizeof(full)) > 0) {}
    long long start = now_ms();
    assert(write_all(pair[0], "x", 1, start + 120) < 0);
    assert(now_ms() - start >= 100 && now_ms() - start < 500);
    close(pair[0]); close(pair[1]);
    return 0;
}
''')
        compile_c(harness, tmp / 'sms-unit', lockflag)
        subprocess.run([str(tmp / 'sms-unit')], check=True, timeout=3)
        # Same backpressure regression for the independent AT helper implementation.
        ah = tmp / 'at-unit.c'
        ah.write_text(r'''
#define main vt_at_main
#include "vt-at.c"
#undef main
#include <assert.h>
#include <sys/socket.h>
int main(void) {
    int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    assert(fcntl(pair[0], F_SETFL, O_NONBLOCK) == 0);
    char full[8192] = {0};
    while (write(pair[0], full, sizeof(full)) > 0) {}
    long long start = now_ms();
    assert(write_all(pair[0], "x", 1, start + 120) < 0);
    assert(now_ms() - start >= 100 && now_ms() - start < 500);
    close(pair[0]); close(pair[1]);
    return 0;
}
''')
        compile_c(ah, tmp / 'at-unit', lockflag)
        subprocess.run([str(tmp / 'at-unit')], check=True, timeout=3)

        def list_reply(kind, line, *_):
            if line == 'AT+CMGL=4':
                return ('\r\n+CMGL: 4,0,,20\r\n' + BAD +
                        '\r\n+CMGL: 5,0,,16\r\n' + VALID + '\r\nOK\r\n').encode()
            return b'\r\nOK\r\n'
        rc, out, _, _, _ = emulate(sms, ['list'], list_reply)
        result = json.loads(out)
        assert rc == 0 and len(result['messages']) == 1, result
        msg = result['messages'][0]
        assert msg['id'] == 5 and msg['text'] == 'A' and msg['concat_total'] == 0, msg
        assert msg['fingerprint'] == VALID

        # Delete only the exact item shown to the user, and require a final OK.
        for current, final, expected_rc, unknown in [(OTHER, b'\r\nOK\r\n', 2, False),
                (VALID, b'\r\n+CMTI: "MT",9\r\n', 2, True),
                (VALID, b'\r\nOK\r\n', 0, False)]:
            def delete_reply(kind, line, *_):
                if line.startswith('AT+CMGR='):
                    return ('\r\n+CMGR: 0,,16\r\n' + current + '\r\nOK\r\n').encode()
                if line.startswith('AT+CMGD='):
                    return final
                return b'\r\nOK\r\n'
            rc, out, _, cmds, _ = emulate(sms, ['-t', '500', 'delete', '5', VALID], delete_reply)
            result = json.loads(out)
            assert rc == expected_rc and result['outcome_unknown'] == unknown, result
            if current != VALID:
                assert result['code'] == 'message_changed' and not any(c.startswith('AT+CMGD=') for c in cmds)
        missing = subprocess.run([str(sms), 'delete', '5'], capture_output=True)
        assert missing.returncode == 64

        # First part accepted, second rejected or left without a final response.
        for second_reply, unknown in [(b'\r\n+CMS ERROR: 500\r\n', False),
                                      (b'\r\n+CMGS: 32\r\n', True),
                                      (b'\r\nOK\r\n', True)]:
            def partial(kind, line, cmds, pdus):
                if kind == 'pdu' and len(pdus) == 2:
                    return second_reply
                return sms_reply(kind, line, cmds, pdus)
            rc, out, _, _, pdus = emulate(sms, ['-t', '2000', 'send', '+1234567890', 'Я' * 71], partial)
            result = json.loads(out)
            assert rc != 0 and len(pdus) == 2, result
            assert result['parts_total'] == 2 and result['parts_confirmed'] == 1, result
            assert result['failed_part'] == 2 and result['outcome_unknown'] == unknown, result

        # Segmentation respects GSM escape pairs and UTF16 surrogate pairs at a boundary.
        for text, encoding in [('a' * 152 + '^' * 77, 'GSM-7'), ('я' * 66 + '😀' * 34, 'UCS-2')]:
            rc, out, _, _, pdus = emulate(sms, ['send', '+1234567890', text], sms_reply)
            result = json.loads(out)
            assert rc == 0 and len(pdus) == 3 and result['parts_confirmed'] == 3, result
            assert result['encoding'] == encoding and not result['outcome_unknown'], result
        print('VT_MODEM_C_TESTS_OK')


if __name__ == '__main__':
    run()
