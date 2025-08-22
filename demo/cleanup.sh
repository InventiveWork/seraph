
#!/bin/bash
set -e

echo "### Deleting Kubernetes cluster 'seraph-demo'... ###"
kind delete cluster --name seraph-demo

echo "### Cleanup complete! ###"
