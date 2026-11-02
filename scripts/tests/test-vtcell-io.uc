'use strict';
import { run, now, write_json, read_json } from '../../package/vtcell/files/usr/share/vtcell/io.uc';
import { unlink, stat } from 'fs';

assert(run(['/usr/bin/printf', '{"ok":true}']).ok === true);
assert(run(['/usr/bin/printf', '{"text":"a\'b $HOME `id`"}']).text === "a'b $HOME `id`");
assert(run(['/bin/sh', '-c', 'printf invalid; exit 1']) === null);
assert(run(['/usr/bin/printf', 'invalid']) === null);
let start=now();
assert(run(['/bin/sleep', '6']) === null);
assert(now()-start < 5500);
let p='/tmp/vtcell-io-test-'+time()+'-'+now()+'.json';
assert(write_json(p,{ok:true}));
assert(read_json(p).ok === true);
assert((stat(p).mode & 0777) === 0600);
unlink(p);
print('VT_CELL_IO_TESTS_OK\n');
