#!/usr/bin/env bash
# designc setup wizard: model provider and Langfuse, one question at a time.
#
#   scripts/setup-wizard.sh [registry-folder]     (default: ./sample-registry)
#
# Writes only env-var NAMES into <registry>/designc.json (merged, other keys kept).
# Keys you type go to ~/.config/designc/env (mode 600), outside every repo.
# Nothing is sent anywhere unless you answer y to a connection test, and the only
# calls are the free auth checks (Langfuse projects, the provider's model list).
set -u

REG="${1:-sample-registry}"
ENVDIR="${XDG_CONFIG_HOME:-$HOME/.config}/designc"
ENVFILE="$ENVDIR/env"
[ -d "$REG" ] || { echo "No folder at $REG. Pass a registry folder."; exit 2; }
command -v node >/dev/null || { echo "node is needed (it merges designc.json)."; exit 2; }

ask() { # ask "question" default -> $REPLY
  local d="${2:-}"; read -r -p "$1${d:+ [$d]}: " REPLY; REPLY="${REPLY:-$d}"; }
yes() { local a; read -r -p "$1 [y/N]: " a; [[ "$a" =~ ^[Yy] ]]; }
secret() { # secret ENVNAME  (hidden entry; keeps an existing value if you press Enter)
  local name="$1" v
  if [ -n "${!name:-}" ]; then echo "  $name is already set in this shell."; return; fi
  read -r -s -p "  Paste $name (hidden, Enter to skip): " v; echo
  [ -n "$v" ] || return 0
  mkdir -p "$ENVDIR"; chmod 700 "$ENVDIR"; touch "$ENVFILE"; chmod 600 "$ENVFILE"
  grep -v "^export $name=" "$ENVFILE" > "$ENVFILE.tmp" || true
  printf 'export %s=%q\n' "$name" "$v" >> "$ENVFILE.tmp"; mv "$ENVFILE.tmp" "$ENVFILE"; chmod 600 "$ENVFILE"
  export "$name=$v"; echo "  Saved to $ENVFILE"
}

echo; echo "== designc setup =="; echo "Registry: $REG"; echo "Step 1 of 3: model provider"
echo "  1) OpenAI-compatible gateway (LiteLLM, APIM, ...)"
echo "  2) Anthropic API"
echo "  3) Claude on Vertex AI (uses gcloud login, no key)"
echo "  4) Skip (no model; the app still works, Grill-me runs through an ACP agent)"
ask "Choose" 4; P="$REPLY"
LLM='null'
case "$P" in
  1) ask "Gateway base URL" "https://gateway/v1"; URL="$REPLY"
     ask "Model name" "claude-sonnet"; M="$REPLY"
     ask "Env var holding the key" "DESIGNC_LLM_API_KEY"; K="$REPLY"
     LLM=$(node -e 'console.log(JSON.stringify({provider:"openai",baseUrl:process.argv[1],model:process.argv[2],apiKeyEnv:process.argv[3]}))' "$URL" "$M" "$K")
     secret "$K"
     if [ -n "${!K:-}" ] && yes "Test the connection (lists models, no tokens spent)?"; then
       curl -fsS -m 15 -H "Authorization: Bearer ${!K}" "${URL%/}/models" >/dev/null && echo "  OK" || echo "  Failed. Check the URL and key."; fi ;;
  2) ask "Model name" "claude-sonnet-5-5"; M="$REPLY"
     ask "Env var holding the key" "ANTHROPIC_API_KEY"; K="$REPLY"
     LLM=$(node -e 'console.log(JSON.stringify({provider:"anthropic",model:process.argv[1],apiKeyEnv:process.argv[2]}))' "$M" "$K")
     secret "$K"
     if [ -n "${!K:-}" ] && yes "Test the key (lists models, no tokens spent)?"; then
       curl -fsS -m 15 -H "x-api-key: ${!K}" -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/models >/dev/null && echo "  OK" || echo "  Failed. Check the key."; fi ;;
  3) ask "Google Cloud project" "${GOOGLE_CLOUD_PROJECT:-}"; PR="$REPLY"
     ask "Region" "global"; RG="$REPLY"
     ask "Model name" "claude-sonnet-5-5"; M="$REPLY"
     LLM=$(node -e 'console.log(JSON.stringify({provider:"vertex",project:process.argv[1],region:process.argv[2],model:process.argv[3]}))' "$PR" "$RG" "$M")
     if command -v gcloud >/dev/null; then
       gcloud auth application-default print-access-token >/dev/null 2>&1 && echo "  Application Default Credentials found." \
         || echo "  No credentials yet. Run: gcloud auth application-default login"
     else echo "  gcloud is not installed. Install it, then: gcloud auth application-default login"; fi ;;
  *) echo "  Skipped." ;;
esac

echo; echo "Step 2 of 3: Langfuse (telemetry for the Build and Review views)"
LF='null'
if yes "Set up Langfuse?"; then
  ask "Langfuse URL" "https://cloud.langfuse.com"; H="$REPLY"
  ask "Env var for the public key" "LANGFUSE_PUBLIC_KEY"; PK="$REPLY"
  ask "Env var for the secret key" "LANGFUSE_SECRET_KEY"; SK="$REPLY"
  ask "Days of history to read" "14"; D="$REPLY"
  LF=$(node -e 'console.log(JSON.stringify({baseUrl:process.argv[1],publicKeyEnv:process.argv[2],secretKeyEnv:process.argv[3],lookbackDays:Number(process.argv[4])||14}))' "$H" "$PK" "$SK" "$D")
  secret "$PK"; secret "$SK"
  if [ -n "${!PK:-}" ] && [ -n "${!SK:-}" ] && yes "Test the keys (reads your project name only)?"; then
    curl -fsS -m 15 -u "${!PK}:${!SK}" "${H%/}/api/public/projects" >/dev/null && echo "  OK" || echo "  Failed. Check the URL and keys."; fi
fi

echo; echo "Step 3 of 3: write the settings"
FILE="$REG/designc.json"
echo "  Will merge into $FILE (secrets are never written there)."
if yes "Write it?"; then
  node -e '
const fs=require("fs");const f=process.argv[1];
let cur={};try{cur=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}
const llm=JSON.parse(process.argv[2]),lf=JSON.parse(process.argv[3]);
if(llm)cur.llm=Object.assign({},cur.llm,llm);
if(lf)cur.langfuse=Object.assign({},cur.langfuse,lf);
fs.writeFileSync(f,JSON.stringify(cur,null,2)+"\n");' "$FILE" "$LLM" "$LF" && echo "  Written."
else echo "  Nothing written."; fi

echo; echo "Done. Before starting designc, load your keys:"
[ -f "$ENVFILE" ] && echo "  source $ENVFILE && npm start -- $REG" || echo "  npm start -- $REG"
echo "In the app, Help > Open settings shows the same page with Test connection."
