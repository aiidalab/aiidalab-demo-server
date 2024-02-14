# aiidalab-demo-server

The instructions are adapted from [z2jh documentation for Azure deployment](https://z2jh.jupyter.org/en/stable/kubernetes/microsoft/step-zero-azure.html).

## Pre-requisites

Install the azure-cli and login to your account.

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az login
```

You’ll need to open a browser and follow the instructions in your terminal to log in.

Consider setting a [cloud budget](https://learn.microsoft.com/en-us/partner-center/set-an-azure-spending-budget-for-your-customers) for your Azure account.
This can only be done by the account owner. It is not yet applied.

Generate an SSH key pair if you don't have one already.

```bash
ssh-keygen -f ssh-key-aiidalab-demo-server
```

## Create an auto-scaling Kubernetes cluster

```bash
az group create --name aiidalab-demo-server-rg --location=switzerlandnorth --output table
```

- `aiidalab-demo-server-rg` is the name of the resource group.

Create networkpolicy for the pods to communicate with each other and to the internet.

```bash
az network vnet create \
   --resource-group aiidalab-demo-server-rg \
   --name aiidalab-vnet \
   --address-prefixes 10.0.0.0/8 \
   --subnet-name aiidalab-subnet \
   --subnet-prefix 10.240.0.0/16
```

We will now retrieve the application IDs of the VNet and subnet we just created and save them to bash variables.

```bash
VNET_ID=$(az network vnet show \
   --resource-group aiidalab-demo-server-rg \
   --name aiidalab-vnet \
   --query id \
   --output tsv)
SUBNET_ID=$(az network vnet subnet show \
   --resource-group aiidalab-demo-server-rg \
   --vnet-name aiidalab-vnet \
   --name aiidalab-subnet \
   --query id \
   --output tsv)
```

Create an Azure Active Directory (Azure AD) service principal for use with the cluster, and assign the Contributor role for use with the VNet.

```bash
SP_PASSWD=$(az ad sp create-for-rbac \
   --name aiidalab-sp \
   --role Contributor \
   --scopes $VNET_ID \
   --query password \
   --output tsv)
SP_ID=$(az ad app list \
   --filter "displayname eq 'aiidalab-sp'" \
   --query "[0].appId" \
   --output tsv)
```

Time to create the Kubernetes cluster, and enable the auto-scaler at the same time.

```bash
az aks create \
   --name demo-server \
   --resource-group aiidalab-demo-server-rg \
   --ssh-key-value ssh-key-aiidalab-demo-server.pub \
   --node-count 3 \
   --node-vm-size Standard_D2s_v3 \
   --service-principal $SP_ID \
   --client-secret $SP_PASSWD \
   --dns-service-ip 10.0.0.10 \
   --network-plugin azure \
   --network-policy azure \
   --service-cidr 10.0.0.0/16 \
   --vnet-subnet-id $SUBNET_ID \
   --vm-set-type VirtualMachineScaleSets \
   --enable-cluster-autoscaler \
   --min-count 3 \
   --max-count 6 \
   --output table
```

```bash
CLUSTER_ID=$(az aks show \
   --resource-group aiidalab-demo-server-rg \
   --name demo-server \
   --query id \
   --output tsv)
```

Update the service principal to have access to the cluster.

```bash
SP_PASSWD=$(az ad sp create-for-rbac \
   --name aiidalab-sp \
   --role Contributor \
   --scopes $CLUSTER_ID $VNET_ID \
   --query password \
   --output table)
```

```bash
az aks update-credentials \
 --resource-group aiidalab-demo-server-rg \
 --name demo-server \
 --reset-service-principal \
 --service-principal <YourServicePrincipalAppId> \
 --client-secret <NewClientSecret>
```


The auto-scaler will scale the number of nodes in the cluster between 3 and 6, based on the CPU and memory usage of the pods.
It can be updated later with the following command:

```bash
az aks update \
   --name demo-server \
   --resource-group aiidalab-demo-server-rg \
   --update-cluster-autoscaler \
   --min-count <DESIRED-MINIMUM-COUNT> \
   --max-count <DESIRED-MAXIMUM-COUNT> \
   --output table
```

### Customizing the auto-scaler

The auto-scaler can be customized to scale based on different metrics, such as CPU or memory usage.
Go to the [Azure portal](https://portal.azure.com/) and navigate to the Kubernetes cluster.
Under the "Resource" section, select the `VMSS`, and then "Custom autoscale".
These are two rules applied to the VMSS:

- Increase the instance count by 1 when the average CPU usage over 10 minutes is greater than 80%
- Decrease the instance count by 1 when the average CPU usage over 10 minutes is less than 5%

## Install kubectl and Helm

The above setup in general is done once.
But make sure the [Pre-requisites](#pre-requisites) are done before proceeding, to have `az` command available.

The following steps are for administrators/maintainers of the cluster to configure in their local machines.

If you’re using the Azure CLI locally, install kubectl, a tool for accessing the Kubernetes API from the commandline:
You may need sudo to install the commands to `/usr/local/bin`.

```bash
az aks install-cli
```

Get credentials from Azure for kubectl to work:

```bash
az aks get-credentials \
   --name demo-server \
   --resource-group aiidalab-demo-server-rg \
   --output table
```

This will update the `~/.kube/config` file with the credentials for the Kubernetes cluster.

Now the nodes are ready to be used.
You can check the status of the nodes with the following command:

```bash
kubectl get nodes
```

Helm is a package manager for Kubernetes, and it is used to install JupyterHub.

```bash
curl https://raw.githubusercontent.com/helm/helm/HEAD/scripts/get-helm-3 | bash
```

## Install JupyterHub

Running the helm command will install JupyterHub with the configuration in `values.yaml`.
Before running the command, make sure the `values.yaml` file is updated with the correct configuration set and read from jinja2 template.

```bash
## Create a python environment for the deployment
python3 -m venv k8s-deploy-venv
source k8s-deploy-venv/bin/activate

## Install the requirements
python3 -m pip install -r requirements.txt
```

Render the `values.yaml` file with the following command:

```bash
jinja2 --format=env basehub/values.yaml.j2 > basehub/values.yaml
```

The following environment variables are required to be set:

* `K8S_NAMESPACE`: The namespace where the JupyterHub will be installed, e.g. `production`, `staging`.
* `OAUTH_CLIENT_ID`: The client ID of the GitHub app.
* `OAUTH_CLIENT_SECRET`: The client secret of the GitHub app.
* `OAUTH_CALLBACK_URL`: The callback URL of the GitHub app.

We use GitHub oauthenticator, the users will be able to login with their GitHub account.
The authentication is created using the `aiidalab` org with app name `aiidalab-demo-production` and `aiidalab-demo-staging` for the production and staging environments respectively.

To deploy the JupyterHub, run the following command:

```bash
./deploy.sh
```

If the namespace does not exist, it will be created.

The IP address of proxy-public service can be retrieved with the following command:

```bash
kubectl get svc proxy-public -n <namespace>
```


## For maintainers and administrators

### Automatic CI/CD deployment

We simply run helm upgrade in CI workflow to deploy the JupyterHub.
The CI workflow requires login to the Azure account, and we use OpenID Connect to authenticate the user.

Go to the entra.microsoft.com and navigate to the `aiidalab-sp` -> `Certificates & secrets` -> `Fedrated credentials`. Set credentials for the GitHub production and staging environments. 

On the GitHub repository, the secrets are set for `production` and `staging` environments respectively.

The `aiidalab-sp` was only assigned the Contributor role for the VNet, and it is not yet assigned to the resource group. This is to avoid the service principal to have too much access to the resources.

To get the kube credentials, the `aiidalab-sp` should be assigned to cluster `demo-server` as well.

### Set up automatic HTTPS with Let's Encrypt

JupyterHub uses Let’s Encrypt to automatically create HTTPS certificates for your deployment.

Specify the two bits of information that we need to automatically provision HTTPS certificates - your domain name & a contact email address.

```yaml
proxy:
  https:
    enabled: true
    hosts:
      - <your-domain-name>
    letsencrypt:
      contactEmail: <your-email-address>
```

