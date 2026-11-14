#!/usr/bin/env bash
#
# Tests the pre-commit secret scan:   bash .githooks/test-pre-commit.sh
#
# Works in a throwaway clone in a temp folder, with a fake db/.env and fake keys
# only (a made-up service-role token, made-up passwords, a made-up private-key block),
# so nothing here is real (the fake secrets are split or built at run time, so this
# file passes the hook itself) and this repo's index is never touched.
#
# It tests the hook as it is in the working tree (committed into the clone first, so the
# resets between cases keep it), and turns the hook on in the clone itself: it never
# assumes it's on (review fix BLD-03, 14 Nov 2026). If the hook isn't on, it stops.
REPO=$(git rev-parse --show-toplevel)
T=$(mktemp -d); S=$T/clone
git clone -q "$REPO" "$S" && cd "$S" || exit 1
git config user.name t && git config user.email t@t
mkdir -p .githooks db && cp "$REPO/.githooks/pre-commit" .githooks/
git add .githooks && git commit -q --allow-empty -m hook || { echo "couldn't commit the hook in the clone"; exit 1; }
git config core.hooksPath .githooks
if [[ "$(git config core.hooksPath)" != ".githooks" || ! -f .githooks/pre-commit ]]; then
  echo "the hook isn't on in the test clone: stopping"; exit 1
fi
PG='postgres''ql://'                       # split, so this file isn't a postgres URL itself
PG2='postgres''://'
printf 'SUPABASE_URL=https://uqirowyfqwiceyjznosl.supabase.co\nSUPABASE_SERVICE_KEY=fake-service-key-0123456789abcdef\nSUPABASE_DB_URL=%spostgres.x:FakePassw0rd99@pooler.example.com:5432/postgres\n' "$PG" > db/.env
b64() { printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\n'; }
H=$(b64 '{"alg":"HS256","typ":"JWT"}'); SR="$H.$(b64 '{"iss":"supabase","ref":"fakeref","role":"service_role","iat":1,"exp":2}').fakesignatureXYZ"
KEYB='-----BEGIN '; KEYE='-----END '      # a fake private-key block, assembled at run time
pem() {  # pem KIND: a made-up key block of that kind
  printf '%s%s-----\nMIIfakefakefakefakefakefakefakefakefake\n%s%s-----\n' "$KEYB" "$1" "$KEYE" "$1"
}
u16le() { printf '\xff\xfe'; iconv -f UTF-8 -t UTF-16LE; }   # what PowerShell 5.1's > writes
u16be() { iconv -f UTF-8 -t UTF-16; }                          # BOM + big-endian
pass=0; fail=0
try() {  # try NAME EXPECT(0|1) SETUP [AFTER]
  eval "$3"; git add -A -- . >/dev/null 2>&1; git commit -qm t >/dev/null 2>"$T/err"; r=$?
  if [[ $r == "$2" ]]; then pass=$((pass+1)); echo "ok   $1 (exit $r)"; else fail=$((fail+1)); echo "FAIL $1 (exit $r, wanted $2)"; cat "$T/err"; fi
  [[ $r == 1 ]] && sed 's/^/       /' "$T/err" | grep -- ' - '
  git reset -q --hard HEAD; git clean -qfd
  [[ -n "${4:-}" ]] && eval "$4"
}
# -- text files (the added lines) ------------------------------------------------------
try "fake service-role key"           1 "echo \"const k = '$SR';\" > tools/x.js"
try "the public anon key"             0 "grep -o \"eyJ[^']*\" app/state.js | head -1 | sed 's/^/const a=\"/; s/\$/\";/' > tools/y.js"
try "db/.env service key value"       1 "echo 'key: fake-service-key-0123456789abcdef' > tools/z.txt"
try "db URL password on its own"      1 "echo 'pw FakePassw0rd99' > tools/z.txt"
try "SUPABASE_URL (public)"           0 "echo 'https://uqirowyfqwiceyjznosl.supabase.co' > tools/z.txt"
try "psk= literal"                    1 "echo 'psk=hunter2hunter2' > pi/conf/w.conf"
try "password= literal"               1 "echo 'password=hunter2hunter2' > pi/conf/w.conf"
try "psk=\$VAR"                       0 "echo 'psk=\$WIFI_PSK' > pi/conf/w.conf"
try "nmconnection with psk"           1 "printf '[wifi-security]\nkey-mgmt=wpa-psk\npsk=realLookingPass1\n' > pi/conf/x.nmconnection"
try "nmconnection, secrets stripped"  0 "printf '[wifi-security]\nkey-mgmt=wpa-psk\npsk-flags=0\n' > pi/conf/x.nmconnection"
try "sb_secret_ key"                  1 "echo 'x=sb_''secret_abcdefghijklmnop' > tools/s.txt"
# -- private-key blocks ------------------------------------------------------------------
try "OpenSSH private key"             1 "pem 'OPENSSH PRIVATE KEY' > tools/id_test"
try "RSA private key"                 1 "pem 'RSA PRIVATE KEY' > tools/k.pem"
try "PKCS#8 private key"              1 "pem 'PRIVATE KEY' > tools/k.pem"
try "encrypted private key"           1 "pem 'ENCRYPTED PRIVATE KEY' > tools/k.pem"
try "a public certificate"            0 "pem 'CERTIFICATE' > tools/ca.crt"
try "a public key"                    0 "pem 'PUBLIC KEY' > tools/k.pub"
# -- postgres URLs -----------------------------------------------------------------------
try "postgres URL with a password, no db/.env" 1 \
    "mv db/.env db/env.off; echo \"DB=${PG}someone:An0therPassw0rd@db.example.com:5432/postgres\" > tools/u.txt" \
    "mv db/env.off db/.env"
try "postgres:// with a password"     1 "echo \"url = '${PG2}u:Xy7-secret-9@host/db'\" > tools/u.py"
try "postgres URL, [YOUR-PASSWORD]"   0 "echo \"${PG}postgres.x:[YOUR-PASSWORD]@pooler.example.com:5432/postgres\" > tools/u.md"
try "postgres URL, <password>"        0 "echo \"${PG}user:<password>@host/db\" > tools/u.md"
try "postgres URL, \$PGPASSWORD"      0 "echo \"${PG}user:\\\$PGPASSWORD@host/db\" > tools/u.md"
try "postgres URL, no password"       0 "echo \"${PG}host.example.com:5432/postgres\" > tools/u.md"
# -- files git treats as binary (scanned whole) ------------------------------------------
try "UTF-16LE file with a service-role key" 1 "echo \"key = $SR\" | u16le > tools/k16.txt"
try "UTF-16BE file with a service-role key" 1 "echo \"key = $SR\" | u16be > tools/k16.txt"
try "UTF-16 file with the db/.env key"      1 "echo 'key: fake-service-key-0123456789abcdef' | u16le > tools/k16.txt"
try "UTF-16 file with a private key"        1 "pem 'RSA PRIVATE KEY' | u16le > tools/k16.txt"
try "UTF-16 file with a postgres password"  1 "echo \"${PG}u:Xy7-secret-9@host/db\" | u16le > tools/k16.txt"
try "UTF-16 file, nothing secret"           0 "echo 'just some notes from PowerShell' | u16le > tools/n16.txt"
try "binary blob with a key inside"         1 "{ printf 'PK\\003\\004\\000\\000\\001'; echo \"$SR\"; printf '\\000\\377\\000'; } > tools/blob.bin"
try "binary blob, nothing secret"           0 "printf 'PK\\003\\004\\000\\000\\001\\002\\377\\000hello\\000' > tools/blob.bin"
# -- files that must never be committed --------------------------------------------------
try "secrets.env (forced add)"        1 "echo 'A=1' > pi/secrets.env; git add -f pi/secrets.env"
try "pi/config.env (forced add)"      1 "echo 'A=1' > pi/config.env; git add -f pi/config.env"
try "pi/config.env.tmp (forced add)"  1 "echo 'A=1' > pi/config.env.tmp; git add -f pi/config.env.tmp"
try "pi/config.env.example edited"    0 "echo '# note' >> pi/config.env.example"
try "docs/security-findings.md"       1 "echo 'x' > docs/security-findings.md; git add -f docs/security-findings.md"
try "an ordinary change"              0 "echo '# hi' >> tools/serve.py"
cd /; rm -rf "$T"
echo "$pass passed, $fail failed"
(( fail == 0 ))
