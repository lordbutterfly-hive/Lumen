#!/bin/bash

set -e

echo "Rolling back to previous version..."
docker service rollback denser_denser-blog
echo "Done. Check status: docker service ls"
