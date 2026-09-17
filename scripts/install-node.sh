#!/bin/bash
set -euo pipefail

INSTALLER_HOME_MARKER='chickpea-node-v1'
NODE_VERSION='24.20.0'
NODE_DARWIN_ARM64_SHA256='40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8'
NODE_DARWIN_X64_SHA256='9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4'
REPOSITORY_API='https://api.github.com/repos/pejmanjohn/chickpea'
REPOSITORY_ARCHIVE='https://codeload.github.com/pejmanjohn/chickpea/tar.gz'

die() { printf 'chickpea-node installer: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }
quote() { printf "'%s'" "${1//\'/\'\\\'\'}"; }

usage() {
  cat <<'EOF'
Usage: install-node.sh [options]
  --home ABSOLUTE_PATH       Installation home (default: ~/.chickpea-node)
  --version vX.Y.Z           Install an immutable application release
  --ref FULL_40_CHAR_SHA     Preview an exact application commit
  --source ABSOLUTE_PATH     Archive a clean local Git checkout at HEAD
  --origin HTTPS_ORIGIN      Public Chickpea origin
  --port PORT                Loopback port (default: 3000)
  --tunnel external|cloudflare
                             HTTPS route mode
  --tunnel-token-file PATH   Private Cloudflare named-tunnel token file
  --cloudflared PATH         Existing cloudflared executable
  --no-start                 Initialize but do not start Chickpea
  --no-open                  Do not open the private setup page
EOF
}

main() {
install_home="${HOME}/.chickpea-node"
version=''
preview_ref=''
local_source=''
origin=''
port='3000'
port_supplied=0
tunnel_token_file=''
cloudflared=''
tunnel_mode=''
start_after=1
open_after=1
selector_count=0

while (($#)); do
  case "$1" in
    --home|--version|--ref|--source|--origin|--port|--tunnel|--tunnel-token-file|--cloudflared)
      (($# >= 2)) || die "$1 requires a value"
      case "$1" in
        --home) install_home=$2 ;;
        --version) version=$2; selector_count=$((selector_count + 1)) ;;
        --ref) preview_ref=$2; selector_count=$((selector_count + 1)) ;;
        --source) local_source=$2; selector_count=$((selector_count + 1)) ;;
        --origin) origin=$2 ;;
        --port) port=$2; port_supplied=1 ;;
        --tunnel) tunnel_mode=$2 ;;
        --tunnel-token-file) tunnel_token_file=$2 ;;
        --cloudflared) cloudflared=$2 ;;
      esac
      shift 2 ;;
    --no-start) start_after=0; shift ;;
    --no-open) open_after=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# Refuse unsupported platforms before creating the installation home or lock.
[[ $(uname -s) == Darwin ]] || die 'initial automated installation supports macOS only; use INSTALL_CHICKPEA_NODE.md for Linux'
machine=$(uname -m)
case "$machine" in
  arm64) node_platform='darwin-arm64'; cloudflared_asset='cloudflared-darwin-arm64.tgz' ;;
  x86_64) node_platform='darwin-x64'; cloudflared_asset='cloudflared-darwin-amd64.tgz' ;;
  *) die "unsupported macOS architecture: $machine" ;;
esac
[[ $(id -u) -ne 0 ]] || die 'refusing to install as root'
# A caller's Node injection settings must never affect the installer runtime,
# release validation, the runtime manager, or the generated management wrapper.
unset NODE_OPTIONS NODE_PATH
[[ $install_home == /* ]] || die '--home must be an absolute path'
[[ $port =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || die '--port must be an integer from 1 through 65535'
((selector_count <= 1)) || die '--version, --ref, and --source are mutually exclusive'
[[ -z $version || $version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die '--version must be vX.Y.Z'
[[ -z $preview_ref || $preview_ref =~ ^[0-9a-f]{40}$ ]] || die '--ref must be a full lowercase 40-character commit SHA'
[[ -z $local_source || $local_source == /* ]] || die '--source must be an absolute path'
[[ -z $tunnel_token_file || $tunnel_token_file == /* ]] || die '--tunnel-token-file must be an absolute path'
[[ -z $cloudflared || $cloudflared == /* ]] || die '--cloudflared must be an absolute path'
[[ -z $tunnel_mode || $tunnel_mode == external || $tunnel_mode == cloudflare ]] || die '--tunnel must be external or cloudflare'
[[ -z $tunnel_token_file || -z $tunnel_mode || $tunnel_mode == cloudflare ]] || die '--tunnel-token-file requires --tunnel cloudflare'
[[ -z $tunnel_token_file || $tunnel_mode != external ]] || die '--tunnel external cannot use --tunnel-token-file'

if [[ -L $install_home ]]; then die 'installation home must not be a symlink'; fi
if [[ -e $install_home/.installer-home ]]; then
  [[ ! -L $install_home/.installer-home ]] || die 'installation ownership marker must not be a symlink'
  [[ $(cat "$install_home/.installer-home") == "$INSTALLER_HOME_MARKER" ]] || die 'installation home has an unknown ownership marker'
elif [[ -e $install_home ]]; then
  [[ -d $install_home ]] || die 'installation home exists and is not a directory'
  [[ -z $(find "$install_home" -mindepth 1 -maxdepth 1 -print -quit) ]] || die 'installation home contains unmanaged content'
  printf '%s\n' "$INSTALLER_HOME_MARKER" > "$install_home/.installer-home"
else
  (umask 077; mkdir -p "$install_home"; printf '%s\n' "$INSTALLER_HOME_MARKER" > "$install_home/.installer-home")
fi
chmod 700 "$install_home"

lock="$install_home/.install-lock"
if ! mkdir "$lock" 2>/dev/null; then
  lock_pid=$(cat "$lock/pid" 2>/dev/null || true)
  if [[ $lock_pid =~ ^[0-9]+$ ]]; then
    die "installer lock is held by PID $lock_pid at $lock; verify that process and its descendants have exited, then remove $(quote "$lock/pid") and run: rmdir $(quote "$lock")"
  fi
  die "installer lock exists at $lock; verify no installer process or descendants remain, then recover with: rmdir $(quote "$lock")"
fi
printf '%s\n' "$$" > "$lock/pid"
work=''
cleanup() {
  status=$?
  [[ -z $work || ! -e $work ]] || rm -rf "$work"
  rm -f "$lock/pid" 2>/dev/null || true
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
work=$(mktemp -d "$install_home/.install-stage.XXXXXX")

download() {
  url=$1 output=$2
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 300 "$url" --output "$output"
}

github_json() {
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 15 \
    --max-time 30 --max-filesize 1048576 \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'User-Agent: chickpea-node-installer' "$1" --output "$2"
}

verify_sha256() {
  file=$1 expected=$2 label=$3
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || die "$label supplied an invalid SHA-256 digest"
  actual=$(shasum -a 256 "$file" | awk '{print $1}')
  [[ $actual == "$expected" ]] || die "$label checksum verification failed"
}

node_root="$install_home/tools/node"
node_bin="$node_root/bin/node"
for managed_path in "$install_home/tools" "$node_root" "$install_home/releases" "$install_home/bin"; do
  [[ ! -L $managed_path ]] || die "managed installation path must not be a symlink: $managed_path"
done
if [[ -e $node_root && ( ! -x $node_bin || $("$node_bin" --version 2>/dev/null || true) != "v$NODE_VERSION" ) ]]; then
  die "existing private Node runtime is incomplete or incompatible at $node_root; preserve it and investigate before retrying"
fi
if [[ ! -x $node_bin ]] || [[ $("$node_bin" --version 2>/dev/null || true) != "v$NODE_VERSION" ]]; then
  node_archive="node-v${NODE_VERSION}-${node_platform}.tar.gz"
  download "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$work/SHASUMS256.txt"
  expected=$(awk -v name="$node_archive" '$2 == name { print $1 }' "$work/SHASUMS256.txt")
  [[ -n $expected ]] || die "Node checksum manifest does not contain $node_archive"
  case "$node_platform" in
    darwin-arm64) pinned_node_digest=$NODE_DARWIN_ARM64_SHA256 ;;
    darwin-x64) pinned_node_digest=$NODE_DARWIN_X64_SHA256 ;;
  esac
  [[ $expected == "$pinned_node_digest" ]] || die 'Node checksum manifest disagrees with the installer-pinned digest'
  download "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}" "$work/$node_archive"
  verify_sha256 "$work/$node_archive" "$expected" 'Node archive'
  mkdir "$work/node"
  tar -xzf "$work/$node_archive" -C "$work/node" --strip-components=1
  [[ $("$work/node/bin/node" --version) == "v$NODE_VERSION" ]] || die 'downloaded Node executable has the wrong version'
  mkdir -p "$install_home/tools"
  [[ ! -L $install_home/tools/node.incomplete ]] || die 'private Node staging path must not be a symlink'
  rm -rf "$install_home/tools/node.incomplete"
  mv "$work/node" "$install_home/tools/node.incomplete"
  [[ ! -e $node_root ]] || die "refusing to replace existing private Node runtime at $node_root"
  mv "$install_home/tools/node.incomplete" "$node_root"
fi

current_sha=''
if [[ -f $install_home/installation.json ]]; then
  [[ ! -L $install_home/installation.json ]] || die 'installation.json must not be a symlink'
  current_sha=$("$node_bin" -e 'try{const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(typeof x.sourceCommit==="string")process.stdout.write(x.sourceCommit)}catch{}' "$install_home/installation.json")
  if [[ -z $origin ]]; then
    origin=$("$node_bin" -e 'try{const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=x.origin||x.publicOrigin;if(typeof v==="string")process.stdout.write(v)}catch{}' "$install_home/installation.json")
  fi
  if ((port_supplied == 0)); then
    saved_port=$("$node_bin" -e 'try{const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(Number.isSafeInteger(x.port))process.stdout.write(String(x.port))}catch{}' "$install_home/installation.json")
    [[ -z $saved_port ]] || port=$saved_port
  fi
  if [[ -z $tunnel_mode ]]; then
    tunnel_mode=$("$node_bin" -e 'try{const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=x.tunnelMode||x.tunnel?.mode;if(v==="external"||v==="cloudflare")process.stdout.write(v)}catch{}' "$install_home/installation.json")
  fi
  if [[ -z $tunnel_token_file ]]; then
    saved_token_file=$("$node_bin" -e 'try{const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=x.tunnel?.tokenFile;if(typeof v==="string")process.stdout.write(v)}catch{}' "$install_home/installation.json")
    [[ -z $saved_token_file ]] || tunnel_token_file=$saved_token_file
  fi
  if [[ -z $cloudflared ]]; then
    saved_cloudflared=$("$node_bin" -e 'try{const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=x.tunnel?.cloudflared;if(typeof v==="string")process.stdout.write(v)}catch{}' "$install_home/installation.json")
    [[ -z $saved_cloudflared ]] || cloudflared=$saved_cloudflared
  fi
fi

if [[ -z $tunnel_mode && -n $tunnel_token_file ]]; then tunnel_mode=cloudflare; fi
if [[ -z $tunnel_mode ]]; then
  if [[ ${CHICKPEA_INSTALL_NONINTERACTIVE:-0} != 1 && -r /dev/tty && -w /dev/tty ]]; then
    printf 'HTTPS route [1 = external, 2 = Cloudflare named tunnel]: ' > /dev/tty
    IFS= read -r tunnel_choice < /dev/tty || die 'unable to read the tunnel choice'
    case "$tunnel_choice" in 1|external) tunnel_mode=external ;; 2|cloudflare) tunnel_mode=cloudflare ;; *) die 'choose external or cloudflare' ;; esac
  else
    die '--tunnel is required when no interactive terminal is available'
  fi
fi
[[ -z $cloudflared || $tunnel_mode == cloudflare ]] || die '--cloudflared requires --tunnel cloudflare'
if [[ -z $origin ]]; then
  if [[ ${CHICKPEA_INSTALL_NONINTERACTIVE:-0} != 1 && -r /dev/tty && -w /dev/tty ]]; then
    printf 'Public HTTPS origin: ' > /dev/tty
    IFS= read -r origin < /dev/tty || die 'unable to read the public origin'
  else
    die '--origin is required when no interactive terminal is available'
  fi
fi
"$node_bin" -e 'try{const u=new URL(process.argv[1]);if(u.protocol!=="https:"||u.username||u.password||u.pathname!=="/"||u.search||u.hash)process.exit(1)}catch{process.exit(1)}' "$origin" 2>/dev/null || die '--origin must be a bare HTTPS origin'

if [[ $tunnel_mode == cloudflare && -z $tunnel_token_file ]]; then
  canonical_token="$install_home/tunnel-token.txt"
  if [[ -f $canonical_token && ! -L $canonical_token ]]; then
    tunnel_token_file=$canonical_token
  else
    [[ ${CHICKPEA_INSTALL_NONINTERACTIVE:-0} != 1 && -r /dev/tty && -w /dev/tty ]] || die '--tunnel-token-file is required for noninteractive Cloudflare tunnel setup'
    tunnel_token_file="$work/tunnel-token.txt"
    printf 'Cloudflare named-tunnel token (input hidden): ' > /dev/tty
    IFS= read -r -s tunnel_token < /dev/tty || die 'unable to read the tunnel token'
    printf '\n' > /dev/tty
    [[ -n $tunnel_token && $tunnel_token != *$'\n'* ]] || die 'tunnel token must be one non-empty line'
    (umask 077; printf '%s\n' "$tunnel_token" > "$tunnel_token_file")
    unset tunnel_token
  fi
fi
reuse_installed=0
if ((selector_count == 0)) && [[ $current_sha =~ ^[0-9a-f]{40}$ ]] &&
   [[ -f $install_home/releases/$current_sha/.installer-complete ]] &&
   [[ ! -L $install_home/releases/$current_sha ]] &&
   [[ ! -L $install_home/releases/$current_sha/.installer-complete ]] &&
   [[ $(cat "$install_home/releases/$current_sha/.installer-complete") == "$current_sha" ]]; then
  reuse_installed=1
  source_tree="$install_home/releases/$current_sha"
  source_sha=$current_sha
else
  source_tree="$work/source"
  mkdir "$source_tree"
  source_sha=''
fi
release_tag=''
release_version=''

if ((reuse_installed)); then
  :
elif [[ -n $local_source ]]; then
  [[ -d $local_source/.git || -f $local_source/.git ]] || die '--source must name a Git checkout'
  git -C "$local_source" diff --quiet --ignore-submodules -- || die '--source has tracked working-tree changes'
  git -C "$local_source" diff --cached --quiet --ignore-submodules -- || die '--source has staged changes'
  source_sha=$(git -C "$local_source" rev-parse --verify HEAD^{commit})
  [[ $source_sha =~ ^[0-9a-f]{40}$ ]] || die 'local source HEAD is not a full commit SHA'
  git -C "$local_source" archive --format=tar HEAD | tar -xf - -C "$source_tree"
elif [[ -n $preview_ref ]]; then
  source_sha=$preview_ref
  download "$REPOSITORY_ARCHIVE/$source_sha" "$work/source.tar.gz"
  tar -xzf "$work/source.tar.gz" -C "$source_tree" --strip-components=1
else
  if [[ -n $version ]]; then
    release_tag=$version
    github_json "$REPOSITORY_API/releases/tags/$release_tag" "$work/release.json"
  else
    github_json "$REPOSITORY_API/releases?per_page=100" "$work/releases.json"
    release_tag=$("$node_bin" -e '
      const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const r=a.find(x=>/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(x.tag_name)&&x.draft===false&&x.prerelease===false&&x.immutable===true);
      if(r)process.stdout.write(r.tag_name);' "$work/releases.json")
    [[ -n $release_tag ]] || die 'GitHub returned no immutable stable application release'
    github_json "$REPOSITORY_API/releases/tags/$release_tag" "$work/release.json"
  fi
  "$node_bin" -e '
    const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")),t=process.argv[2];
    if(r.tag_name!==t||r.draft!==false||r.prerelease!==false||r.immutable!==true||r.html_url!==`https://github.com/pejmanjohn/chickpea/releases/tag/${t}`)process.exit(1);' "$work/release.json" "$release_tag" || die 'requested release is not an immutable published official application release'
  github_json "$REPOSITORY_API/git/ref/tags/$release_tag" "$work/ref.json"
  source_sha=$("$node_bin" - "$work/ref.json" "$REPOSITORY_API" <<'NODE'
const fs=require('fs'); let o=JSON.parse(fs.readFileSync(process.argv[2],'utf8')).object;
(async()=>{for(let i=0;o&&o.type==='tag'&&i<5;i++){
  if(!/^[0-9a-f]{40}$/.test(o.sha))process.exit(1);
  const r=await fetch(`${process.argv[3]}/git/tags/${o.sha}`,{redirect:'error',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'chickpea-node-installer'}});
  if(!r.ok||!String(r.headers.get('content-type')).includes('json'))process.exit(1);
  const bytes=new Uint8Array(await r.arrayBuffer()); if(bytes.length>1048576)process.exit(1);
  o=JSON.parse(new TextDecoder().decode(bytes)).object;
}
if(!o||o.type!=='commit'||!/^[0-9a-f]{40}$/.test(o.sha))process.exit(1); process.stdout.write(o.sha);})().catch(()=>process.exit(1));
NODE
  ) || die 'official release tag did not resolve to one commit'
  release_version=${release_tag#v}
  download "$REPOSITORY_ARCHIVE/$source_sha" "$work/source.tar.gz"
  tar -xzf "$work/source.tar.gz" -C "$source_tree" --strip-components=1
fi

[[ $source_sha =~ ^[0-9a-f]{40}$ ]] || die 'source did not resolve to a full commit SHA'
if [[ -n $current_sha && $current_sha != "$source_sha" ]]; then
  die 'this installation already uses a different release; back up the stopped installation and follow the manual Node upgrade procedure'
fi

package_version=$("$node_bin" -e 'const p=require(process.argv[1]);if(typeof p.version!=="string")process.exit(1);process.stdout.write(p.version)' "$source_tree/package.json") || die 'source package.json is invalid'
manifest_version=$("$node_bin" -e 'const p=require(process.argv[1]);if(typeof p.version!=="string")process.exit(1);process.stdout.write(p.version)' "$source_tree/release.json") || die 'source release.json is invalid'
[[ $package_version == "$manifest_version" ]] || die 'package.json and release.json versions disagree'
[[ -z $release_version || $package_version == "$release_version" ]] || die 'release tag and application version disagree'
lock_versions=$("$node_bin" -e 'const x=require(process.argv[1]),v=process.argv[2];const a=x.version,b=x.packages?.[""]?.version;if(a!==v||b!==v)process.exit(1);process.stdout.write(v)' "$source_tree/package-lock.json" "$package_version") || die 'package-lock.json root versions disagree with the application version'
[[ $(tr -d '[:space:]' < "$source_tree/.nvmrc") == "$NODE_VERSION" ]] || die "source requires a different Node pin; this installer supports $NODE_VERSION"
[[ -f $source_tree/scripts/install-node.sh && -f $source_tree/scripts/chickpea-node.mjs ]] || die "selected source predates the one-command Node installer; choose a compatible release or use --ref/--source for a reviewed preview"
archive_sha=$("$node_bin" -e 'try{const x=require(process.argv[1]);if(typeof x.commit==="string")process.stdout.write(x.commit)}catch{}' "$source_tree/release-source.json")
[[ $archive_sha == "$source_sha" ]] || die 'source archive provenance does not match the selected commit'
if [[ -n $preview_ref || -n $local_source ]]; then
  note "WARNING: installing preview source $source_sha; this is not an immutable published application release."
fi

release_root="$install_home/releases/$source_sha"
complete="$release_root/.installer-complete"
[[ ! -L $release_root ]] || die "managed release must not be a symlink: $release_root"
[[ ! -L $complete ]] || die "release completeness marker must not be a symlink: $complete"
if ((reuse_installed)); then
  :
elif [[ ! -f $complete ]]; then
  npm_user_config="$work/npm-user.conf"
  npm_global_config="$work/npm-global.conf"
  : > "$npm_user_config"
  : > "$npm_global_config"
  env -i HOME="$install_home/build-home" PATH="$node_root/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    DO_NOT_TRACK=1 npm_config_userconfig="$npm_user_config" npm_config_globalconfig="$npm_global_config" \
    "$node_root/bin/npm" ci --strict-allow-scripts --prefix "$source_tree"
  env -i HOME="$install_home/build-home" PATH="$node_root/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    DO_NOT_TRACK=1 npm_config_userconfig="$npm_user_config" npm_config_globalconfig="$npm_global_config" \
    "$node_root/bin/npm" run flue:build --prefix "$source_tree"
  [[ -f $source_tree/dist/app.mjs && -f $source_tree/dist/node-background.mjs ]] || die 'application build did not produce the production Node artifacts'
  printf '%s\n' "$source_sha" > "$source_tree/.installer-complete"
  mkdir -p "$install_home/releases"
  [[ ! -e $release_root ]] || die 'incomplete release stage already exists; preserve it and investigate'
  mv "$source_tree" "$release_root"
elif [[ $(cat "$complete") != "$source_sha" ]]; then
  die 'installed release completeness marker is invalid'
fi

if [[ -n $cloudflared ]]; then
  [[ -x $cloudflared ]] || die '--cloudflared must be an existing executable'
  cloudflared=$("$node_bin" -e 'const fs=require("fs");const p=fs.realpathSync(process.argv[1]);if(!fs.statSync(p).isFile())process.exit(1);process.stdout.write(p)' "$cloudflared") || die 'unable to resolve the cloudflared executable'
  cf_version=$("$cloudflared" version 2>/dev/null | sed -nE 's/.*version ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -1)
  [[ $cf_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'unable to read the cloudflared version'
  "$node_bin" -e 'const a=process.argv[1].split(".").map(Number),b=[2025,4,0];for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}' "$cf_version" || die 'cloudflared must be version 2025.4.0 or newer'
elif [[ $tunnel_mode == cloudflare ]]; then
  [[ -f $tunnel_token_file && ! -L $tunnel_token_file ]] || die '--tunnel-token-file must be an existing non-symlink file'
  mode=$(stat -f '%Lp' "$tunnel_token_file")
  (( (8#$mode & 077) == 0 )) || die '--tunnel-token-file must not be accessible by group or others'
  # Pin the latest official release metadata and verify its published digest.
  github_json 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' "$work/cloudflared-release.json"
  cf_url=$("$node_bin" -e 'const r=require(process.argv[1]),n=process.argv[2],a=r.assets.find(x=>x.name===n);if(a&&a.browser_download_url)process.stdout.write(a.browser_download_url)' "$work/cloudflared-release.json" "$cloudflared_asset")
  cf_digest=$("$node_bin" -e 'const r=require(process.argv[1]),n=process.argv[2],a=r.assets.find(x=>x.name===n);if(a&&/^sha256:[0-9a-f]{64}$/.test(a.digest||""))process.stdout.write(a.digest.slice(7))' "$work/cloudflared-release.json" "$cloudflared_asset")
  [[ -n $cf_url && -n $cf_digest ]] || die 'official cloudflared release metadata lacks the required asset digest'
  download "$cf_url" "$work/cloudflared.tgz"
  verify_sha256 "$work/cloudflared.tgz" "$cf_digest" 'cloudflared archive'
  mkdir "$work/cloudflared"
  tar -xzf "$work/cloudflared.tgz" -C "$work/cloudflared"
  cf_candidate=$(find "$work/cloudflared" -type f -name cloudflared -print -quit)
  [[ -n $cf_candidate ]] || die 'cloudflared archive did not contain cloudflared'
  chmod 700 "$cf_candidate"
  [[ ! -L $install_home/tools/cloudflared ]] || die 'managed cloudflared directory must not be a symlink'
  mkdir -p "$install_home/tools/cloudflared"
  [[ ! -e $install_home/tools/cloudflared/cloudflared && ! -L $install_home/tools/cloudflared/cloudflared ]] || die 'refusing to replace an existing unmanaged cloudflared executable'
  cf_stage="$install_home/tools/cloudflared/.cloudflared.$$.tmp"
  [[ ! -e $cf_stage && ! -L $cf_stage ]] || die 'cloudflared staging path already exists'
  mv "$cf_candidate" "$cf_stage"
  mv "$cf_stage" "$install_home/tools/cloudflared/cloudflared"
  cloudflared="$install_home/tools/cloudflared/cloudflared"
fi

runtime_args=(--home "$install_home" init --origin "$origin" --port "$port")
[[ -z $tunnel_token_file ]] || runtime_args+=(--tunnel-token-file "$tunnel_token_file")
[[ -z $cloudflared ]] || runtime_args+=(--cloudflared "$cloudflared")
runtime_args+=(--tunnel "$tunnel_mode")
"$node_bin" "$release_root/scripts/chickpea-node.mjs" "${runtime_args[@]}"

mkdir -p "$install_home/bin"
wrapper="$install_home/bin/chickpea-node"
[[ ! -L $wrapper ]] || die 'managed command wrapper must not be a symlink'
[[ ! -e $wrapper || -f $wrapper ]] || die 'managed command wrapper must be a regular file'
wrapper_tmp="$install_home/bin/.chickpea-node.$$.tmp"
[[ ! -e $wrapper_tmp && ! -L $wrapper_tmp ]] || die 'command wrapper staging path already exists'
cat > "$wrapper_tmp" <<EOF
#!/bin/bash
unset NODE_OPTIONS NODE_PATH
exec $(quote "$node_bin") $(quote "$install_home/current/scripts/chickpea-node.mjs") --home $(quote "$install_home") "\$@"
EOF
chmod 700 "$wrapper_tmp"
"$node_bin" -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$wrapper_tmp" "$wrapper"
ln_tmp="$install_home/.current.$$.tmp"
ln -s "releases/$source_sha" "$ln_tmp"
"$node_bin" -e '
  const fs=require("fs"),tmp=process.argv[1],current=process.argv[2],expected=process.argv[3];
  try {
    const s=fs.lstatSync(current);
    if(!s.isSymbolicLink()||fs.readlinkSync(current)!==expected)process.exit(2);
  } catch(e) { if(e.code!=="ENOENT")throw e; }
  fs.renameSync(tmp,current);' "$ln_tmp" "$install_home/current" "releases/$source_sha" || die 'current release pointer is not a managed installer symlink'

note "Installed Chickpea $package_version from $source_sha."
note "Management command: $(quote "$wrapper") status"
note 'For a new installation, finish Slack and provider setup in the browser and verify a real Slack reply.'
if ((start_after)); then
  start_args=(start)
  ((open_after)) && start_args+=(--open)
  rm -rf "$work"
  work=''
  rm -f "$lock/pid"
  rmdir "$lock"
  trap - EXIT HUP INT TERM
  exec "$wrapper" "${start_args[@]}"
fi
note "Start command: $(quote "$wrapper") start$([[ $open_after == 1 ]] && printf ' --open')"
}

# Defining the whole installer before invoking it prevents a truncated
# `curl | bash` transfer from executing a valid-looking prefix.
main "$@"
