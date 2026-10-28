#!/usr/bin/env bash
set -Eeuo pipefail
exec 9>/tmp/dsh-production-plugin-deploy.lock
flock -n 9
root='/home/moye/Online Document'
container=dsh-docker-dsh-1
image=dsh-official-npm:0.2.1-rc.2
volume=dsh-production-021-20261019
package=${1:?Provide the verified absolute package archive path}
test "$(docker inspect "$container" --format '{{.Config.Image}}')" = "$image"
test "$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')" = "$volume"
test -s "$package"
partners=$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/home/node"}}{{.Source}}{{end}}{{end}}')/partners
test -d "$partners"
test "$(docker ps --filter volume="$volume" --format '{{.Names}}')" = "$container"
backup=$(mktemp -d "$root/dsh-docker/backups/partner-2100-XXXXXXXX")
chmod 700 "$backup"
echo "Backup: $backup"
helper(){ docker run --rm --user root --entrypoint node -v "$volume:/data" -v "$partners:/partner-workspaces:ro" -v "$backup:/backup" -v "$package:/package.tgz:ro" -v "$root/dsh-plugins/dsh-partner/ops/install-partner-2100.mjs:/install.mjs:ro" "$image" /install.mjs "$@"; }
rollback(){
  trap - ERR
  docker stop -t 90 "$container" >/dev/null || true
  if test -f "$backup/install-state.json"; then helper restore; fi
  docker start "$container" >/dev/null
  echo "Deployment failed; previous package restored. Backup: $backup"
  exit 1
}
trap rollback ERR
docker stop -t 90 "$container" >/dev/null
helper install
docker start "$container" >/dev/null
ready_deadline=$((SECONDS + 600))
while (( SECONDS < ready_deadline )); do
  if test "$(docker inspect "$container" --format '{{.State.Health.Status}}')" = healthy && curl --noproxy '*' -fsS --max-time 10 http://127.0.0.1:3080/partner-local/v1 >/dev/null; then
    docker exec -u node "$container" node --input-type=module -e '
      import assert from "node:assert/strict";
      import {readFile} from "node:fs/promises";
      const root="/data/profiles/web/node_modules/@lemoncat7/dsh-partner";
      const pkg=JSON.parse(await readFile(root+"/package.json"));assert.equal(pkg.version,"2.10.0");
      const {BUILTIN_SKILLS}=await import(root+"/lib/skills/builtin.js");
      const {loadBuiltinResources}=await import(root+"/lib/skills/builtin-resources.js");
      assert.ok(BUILTIN_SKILLS.has("ai-camera-language"));
      for(const skill of BUILTIN_SKILLS.values())if(skill.resourceBundle)await loadBuiltinResources(skill.resourceBundle);
      console.log("Production package 2.10.0: builtin catalog and resource hashes verified");'
    trap - ERR
    echo "Healthy: $container; backup retained at $backup"
    exit 0
  fi
  sleep 2
done
false
