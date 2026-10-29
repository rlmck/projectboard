#!/usr/bin/env bash
#
# Tests the pre-commit secret scan:   bash .githooks/test-pre-commit.sh
#
# Works in a throwaway clone in a temp folder, with a fake db/.env and fake keys
# only (a made-up service-role token, made-up passwords), so nothing here is real
# (the fake keys are split or built at run time, so this file passes the hook itself)
# and this repo's index is never touched.
REPO=$(git rev-parse --show-toplevel)
S=$(mktemp -d)/clone
git clone -q "$REPO" "$S" && cd "$S" || exit 1
mkdir -p .githooks db && cp "$REPO/.githooks/pre-commit" .githooks/ && git config user.name t && git config user.email t@t
git add .githooks && git commit -qm hook && git config core.hooksPath .githooks
printf 'SUPABASE_URL=https://uqirowyfqwiceyjznosl.supabase.co\nSUPABASE_SERVICE_KEY=fake-service-key-0123456789abcdef\nSUPABASE_DB_URL=postgresql://postgres.x:FakePassw0rd99@pooler.example.com:5432/postgres\n' > db/.env
b64() { printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\n'; }
H=$(b64 '{"alg":"HS256","typ":"JWT"}'); SR="$H.$(b64 '{"iss":"supabase","ref":"fakeref","role":"service_role","iat":1,"exp":2}').fakesignatureXYZ"
pass=0; fail=0
try() {  # try NAME EXPECT(0|1) SETUP
  eval "$3"; git add -A -- . >/dev/null 2>&1; git commit -qm t >/dev/null 2>"$S.err"; r=$?
  if [[ $r == "$2" ]]; then pass=$((pass+1)); echo "ok   $1 (exit $r)"; else fail=$((fail+1)); echo "FAIL $1 (exit $r, wanted $2)"; cat "$S.err"; fi
  [[ $r == 1 ]] && sed 's/^/       /' "$S.err" | grep -- ' - '
  git reset -q --hard HEAD; git clean -qfd
}
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
try "secrets.env (forced add)"        1 "echo 'A=1' > pi/secrets.env; git add -f pi/secrets.env"
try "pi/config.env (forced add)"      1 "echo 'A=1' > pi/config.env; git add -f pi/config.env"
try "docs/security-findings.md"       1 "echo 'x' > docs/security-findings.md; git add -f docs/security-findings.md"
try "an ordinary change"              0 "echo '# hi' >> tools/serve.py"
cd /; rm -rf "$(dirname "$S")"
echo "$pass passed, $fail failed"
(( fail == 0 ))
