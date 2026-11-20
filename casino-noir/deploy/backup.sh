#!/bin/sh
# Daily compressed dump of the database, keeping the last 14 days locally.
# Copy ./backups off-site (S3 bucket with object lock / versioning) with your host's tooling.
set -eu
while true; do
  pg_dump -h db -U noir -Fc noir > "/backups/noir-$(date +%F).dump"
  ls -1t /backups/noir-*.dump | tail -n +15 | while read -r old; do rm -f -- "$old"; done
  sleep 86400
done
