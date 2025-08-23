
#!/bin/bash
set -e

echo "### 1. Creating Kubernetes cluster with kind... ###"
kind create cluster --name seraph-demo

echo "### 2. Adding Helm repositories... ###"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

echo "### 3. Installing Prometheus and Alertmanager... ###"
# We create a 'monitoring' namespace for these components
kubectl create namespace monitoring
helm install prometheus prometheus-community/kube-prometheus-stack --namespace monitoring

echo "### 4. Building and loading sample-app Docker image... ###"
docker build -t sample-app:latest ./demo/sample-app
kind load docker-image sample-app:latest --name seraph-demo

echo "### Setup complete! ###"
echo "Your Kubernetes cluster is running."
echo "Prometheus and Alertmanager are installed in the 'monitoring' namespace."
echo "The sample-app image has been loaded into the cluster."
echo "Next, follow the DEMO_GUIDE.md to deploy the applications."
