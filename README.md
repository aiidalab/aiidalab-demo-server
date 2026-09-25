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

## Creating a cluster

One procedure for every environment. Set the variables for the one you are building, then
run the steps below unchanged — they only refer to those variables.

Names derive from `PROJECT` and `ENV` so they cannot drift apart. Production predates that
and states its names literally; the comments show what the scheme would produce, for whenever
it is next rebuilt.

This is needed rarely: production already exists, and staging has no cluster of its own.

### 1. Variables

<details>
<summary><b>production</b> — as built, for reference</summary>

Already exists. These are the values it actually has, verified against the live cluster —
useful for rebuilding it, not for running now.

```bash
ENV=production
PROJECT=aiidalab-demo
LOCATION=eastus

# Literal, not derived: these predate the naming scheme and cannot be changed
# without rebuilding the cluster. What they would be called today is in comments.
RG=aiidalab-demo-server          # ${PROJECT}-${ENV}
CLUSTER=demo-server-production   # ${PROJECT}-${ENV}
VNET=aiidalab-demo-vnet          # ${RG}-vnet
SUBNET=aiidalab-demo-subnet      # ${RG}-subnet

VNET_PREFIX=10.0.0.0/8;          SUBNET_PREFIX=10.240.0.0/16
SERVICE_CIDR=10.0.0.0/16;        DNS_SERVICE_IP=10.0.0.10
SYSTEM_VM=Standard_D2s_v5;       SYSTEM_COUNT=1
USER_VM=Standard_D8s_v5;         USER_MIN=1; USER_MAX=7
OS_DISK_TYPE=Managed;            OS_DISK_GB=128
NETWORKING_RG=aiidalab-networking
DNS_ZONE=aiidalab.io;            DNS_RECORD=demo
```

> ⚠️ Its `SERVICE_CIDR` sits **inside** `VNET_PREFIX`. Azure asks that they not overlap; it
> works today only because the subnet happens to sit elsewhere in that range. Do not copy this
> layout into a new cluster — use the one in the `dev` block.

</details>

<details>
<summary><b>staging</b> — no cluster to create</summary>

Staging runs as a **namespace on the production cluster**, so there is nothing to build here.
Skip to [Configuration](#configuration) and give it its own identity, scoped to that namespace:

```bash
ENV=staging
RG=aiidalab-demo-server          # production's
CLUSTER=demo-server-production   # production's
NAMESPACE=staging
```

Its CI identity gets `Azure Kubernetes Service RBAC Writer` on
`<cluster>/namespaces/staging` and nothing wider — that scope is what keeps a staging deploy
out of production.

</details>

<details>
<summary><b>dev</b> — per-pull-request previews</summary>

```bash
ENV=dev
PROJECT=aiidalab-demo
LOCATION=eastus

# Derived — four names from two variables, so they cannot drift apart.
RG=${PROJECT}-${ENV}
CLUSTER=${PROJECT}-${ENV}
VNET=${RG}-vnet
SUBNET=${RG}-subnet

VNET_PREFIX=10.240.0.0/16;       SUBNET_PREFIX=10.240.0.0/20
SERVICE_CIDR=10.0.0.0/16;        DNS_SERVICE_IP=10.0.0.10
SYSTEM_VM=Standard_D2ds_v5;      SYSTEM_COUNT=1
OS_DISK_TYPE=Ephemeral;          OS_DISK_GB=64
NETWORKING_RG=aiidalab-networking
INGRESS_IP=20.163.208.33
DNS_ZONE=aiidalab.xyz;           DNS_RECORD='*.demo'
```

The `d` in `D2ds_v5` is load-bearing — only `d` sizes have the local temp disk that ephemeral
OS disks need, and those are what make a stopped cluster nearly free.

Note the network layout differs from production's: here `SERVICE_CIDR` is outside
`VNET_PREFIX`, which is what Azure actually asks for.

</details>

### 2. Resource group and network

```bash
az group create --name "$RG" --location "$LOCATION" --output none

az network vnet create \
   --resource-group "$RG" --name "$VNET" \
   --address-prefixes "$VNET_PREFIX" \
   --subnet-name "$SUBNET" --subnet-prefix "$SUBNET_PREFIX" \
   --output none

SUBNET_ID=$(az network vnet subnet show \
   --resource-group "$RG" --vnet-name "$VNET" --name "$SUBNET" \
   --query id --output tsv)
```

### 3. The cluster

```bash
az aks create \
   --resource-group "$RG" --name "$CLUSTER" --location "$LOCATION" \
   --tier free \
   --enable-managed-identity \
   --enable-aad --enable-azure-rbac \
   --node-count "$SYSTEM_COUNT" --node-vm-size "$SYSTEM_VM" \
   --node-osdisk-type "$OS_DISK_TYPE" --node-osdisk-size "$OS_DISK_GB" \
   --network-plugin azure --network-policy azure \
   --service-cidr "$SERVICE_CIDR" --dns-service-ip "$DNS_SERVICE_IP" \
   --vnet-subnet-id "$SUBNET_ID" \
   --enable-oidc-issuer --enable-workload-identity \
   --output none
```

`--enable-aad --enable-azure-rbac` must be set at creation: enabling them later invalidates
every existing kubeconfig. `--enable-oidc-issuer --enable-workload-identity` is what later lets
cert-manager hold an Azure identity, since a pod cannot borrow the cluster's own. Both fail
quietly if omitted — nothing breaks until much later.

**`OS_DISK_TYPE=Ephemeral` constrains `OS_DISK_GB`.** An ephemeral OS disk lives on the VM's
local temp disk, so it has to fit: `Standard_D2ds_v5` offers 75 GiB, while AKS defaults to
asking for 128 GiB. Leave the default and creation fails outright with
`VMCannotFitEphemeralOSDisk`. 64 GiB fits comfortably and is ample for a node.

Ephemeral is worth this fuss only where the cluster sleeps — a stopped cluster still bills for
managed OS disks. Production keeps `Managed`.

Production also has a **user node pool** — the pool that actually serves users:

```bash
az aks nodepool add \
   --resource-group "$RG" --cluster-name "$CLUSTER" --name users \
   --node-vm-size "$USER_VM" --mode User \
   --enable-cluster-autoscaler --min-count "$USER_MIN" --max-count "$USER_MAX" \
   --output none
```

Dev does not need one: a single system pool is enough for a handful of testers.

### 4. Access

Grant cluster admin **through Entra**, not the local certificate. Without this, `kubectl`
returns `Forbidden` even for subscription Owners, because Azure RBAC governs the Kubernetes
API separately from Azure resource permissions.

Assign the **group**, not yourself: a recovery path that depends on one person stops being a
recovery path the week they are away.

```bash
ADMINS_GROUP=$(az ad group list --display-name "AiiDAlab Admins" --query "[0].id" -o tsv)
CLUSTER_ID=$(az aks show -g "$RG" -n "$CLUSTER" --query id -o tsv)

az role assignment create \
   --assignee "$ADMINS_GROUP" \
   --role "Azure Kubernetes Service RBAC Cluster Admin" \
   --scope "$CLUSTER_ID"

az aks get-credentials -g "$RG" -n "$CLUSTER" --overwrite-existing
kubelogin convert-kubeconfig -l azurecli
kubectl get ns
```

The CI identity for this environment is created separately — see
[Secrets and variables kept in GitHub](#secrets-and-variables-kept-in-github).

### 5. The CI identity

Each environment deploys as its own app registration, so one environment's pipeline cannot
use another's credentials. There is no stored secret: GitHub Actions exchanges an OIDC token
for an Azure one, and the trust comes from a *federated credential* naming this repository and
environment.

```bash
APP_ID=$(az ad app create --display-name "aiidalab-demo-${ENV}-sp" --query appId -o tsv)
az ad sp create --id "$APP_ID"

az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"${ENV}\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:aiidalab/aiidalab-demo-server:environment:${ENV}\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"

echo "AZURE_CLIENT_ID = $APP_ID"
```

The `subject` must equal the GitHub environment name **exactly**. A mismatch fails with
`AADSTS70021: No matching federated identity record found`, which names neither side.

Then two roles. The first lets it fetch a kubeconfig; the second decides what it may then do:

```bash
CLUSTER_ID=$(az aks show -g "$RG" -n "$CLUSTER" --query id -o tsv)

az role assignment create --assignee "$APP_ID" \
   --role "Azure Kubernetes Service Cluster User Role" --scope "$CLUSTER_ID"
```

| Environment | Second role | Scope |
|---|---|---|
| production | `Azure Kubernetes Service RBAC Writer` | `$CLUSTER_ID` |
| staging | `Azure Kubernetes Service RBAC Writer` | `$CLUSTER_ID/namespaces/staging` |
| dev | `Azure Kubernetes Service RBAC Cluster Admin` | `$CLUSTER_ID` |

Staging's namespace scope is what keeps a staging deploy out of production — it is the whole
reason staging can share production's cluster.

Dev needs Cluster Admin because previews create and delete `pr-N` namespaces, and **neither
RBAC Writer nor RBAC Admin can do that**: Writer does not list namespaces among its actions,
and Admin explicitly excludes `namespaces/write` and `namespaces/delete`. That is tolerable
only because dev is a cluster of its own, containing nothing but previews.

> The same limitation means a **namespace-scoped identity cannot recreate its own namespace**.
> If `staging` is ever deleted, CI cannot bring it back — recreate it with an admin credential
> first.

Dev also needs a second, destructive-only identity for teardown. Required reviewers apply to
every job declaring an environment, so a cleanup job sharing `dev` would wait for an approval
nobody gives, and previews would never be removed. Repeat the steps above with `ENV=dev-cleanup`
and an unprotected GitHub environment.

Finally, so the cluster can adopt the reserved ingress address:

```bash
CLUSTER_IDENTITY=$(az aks show -g "$RG" -n "$CLUSTER" --query identity.principalId -o tsv)
az role assignment create --assignee "$CLUSTER_IDENTITY" \
   --role "Network Contributor" \
   --scope "$(az group show -n "$NETWORKING_RG" --query id -o tsv)"
```

### 6. Ingress and DNS

For **dev this is already done** — `aiidalab-networking` holds `dev-ingress`
(`20.163.208.33`) and `*.demo.aiidalab.xyz` already points at it. The steps below are how it
was made, and what to repeat for another environment.

**Reserve the address before the cluster needs it**, in a resource group that is not the
cluster's. A public IP created *by* AKS lives in its `MC_*` group and is destroyed with the
cluster, which leaves the DNS record pointing at an address someone else can claim.

```bash
az group create --name "$NETWORKING_RG" --location "$LOCATION" --output none

az network public-ip create \
   --resource-group "$NETWORKING_RG" --name "${ENV}-ingress" \
   --location "$LOCATION" --sku Standard --allocation-method Static \
   --output none

IP=$(az network public-ip show -g "$NETWORKING_RG" -n "${ENV}-ingress" --query ipAddress -o tsv)
```

Point DNS at it. Dev's `DNS_RECORD` is a wildcard, so every `pr-N` preview resolves without a
new record; production names a single host:

```bash
az network dns record-set a add-record \
   --resource-group dns-zones --zone-name "$DNS_ZONE" \
   --record-set-name "$DNS_RECORD" --ipv4-address "$IP" --ttl 300
```

For the cluster's load balancer to adopt an IP from another resource group, the service must
carry `service.beta.kubernetes.io/azure-load-balancer-resource-group: $NETWORKING_RG`, and the
cluster identity needs **Network Contributor** on that group. Without the annotation AKS
silently allocates a *different* IP and the DNS record quietly points nowhere.


### 7. Ingress controller and certificates

Only needed where many hostnames share one address — that is, dev. Production and staging each
serve a single host through the chart's own `proxy.https`, and can skip this.

Wildcard DNS resolves every `pr-N` name to the same IP, so a per-namespace `LoadBalancer`
cannot work: they would all contend for one address. Instead one ingress controller owns the
address, and each preview gets an `Ingress` that routes by `Host`.

**The controller**, claiming the reserved IP:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
   --namespace ingress-nginx --create-namespace \
   --set controller.service.loadBalancerIP="$INGRESS_IP" \
   --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-resource-group"="$NETWORKING_RG" \
   --set controller.extraArgs.default-ssl-certificate=ingress-nginx/wildcard-tls
```

Without that annotation AKS looks for the IP in its own node resource group, does not find it,
and **silently allocates a different one** — the DNS record then points nowhere.

`default-ssl-certificate` is what lets one wildcard serve every preview. Without it each
`pr-N` namespace would need its own copy of the TLS secret, which means another component to
replicate it.

**cert-manager**, and the wildcard itself. DNS-01 is required: HTTP-01 cannot prove a wildcard.

cert-manager runs as a pod, and a pod cannot use the cluster's own identity. Give it a
**user-assigned identity** federated to its service account — this is what
`--enable-workload-identity` above was for:

```bash
az identity create -g "$RG" -n cert-manager --location "$LOCATION" --output none
CM_CLIENT_ID=$(az identity show -g "$RG" -n cert-manager --query clientId -o tsv)
CM_PRINCIPAL=$(az identity show -g "$RG" -n cert-manager --query principalId -o tsv)
OIDC=$(az aks show -g "$RG" -n "$CLUSTER" --query oidcIssuerProfile.issuerURL -o tsv)

az identity federated-credential create \
   --identity-name cert-manager --resource-group "$RG" --name cert-manager \
   --issuer "$OIDC" \
   --subject "system:serviceaccount:cert-manager:cert-manager" \
   --audiences api://AzureADTokenExchange --output none

az role assignment create --assignee "$CM_PRINCIPAL" --role "DNS Zone Contributor" \
   --scope "$(az network dns zone show -g dns-zones -n "$DNS_ZONE" --query id -o tsv)"
```

```bash
helm repo add jetstack https://charts.jetstack.io
helm upgrade --install cert-manager jetstack/cert-manager \
   --namespace cert-manager --create-namespace \
   --set crds.enabled=true \
   --set podLabels."azure\.workload\.identity/use"=true \
   --set serviceAccount.labels."azure\.workload\.identity/use"=true \
   --set-string serviceAccount.annotations."azure\.workload\.identity/client-id"="$CM_CLIENT_ID"
```

The issuer and the certificate. `SUB` and `DNS_RG` are the subscription and the zone's
resource group:

```bash
SUB=$(az account show --query id -o tsv)

kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: aiidalab@materialscloud.org
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - dns01:
          azureDNS:
            subscriptionID: ${SUB}
            resourceGroupName: dns-zones
            hostedZoneName: ${DNS_ZONE}
            environment: AzurePublicCloud
            managedIdentity:
              clientID: ${CM_CLIENT_ID}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard
  namespace: ingress-nginx
spec:
  secretName: wildcard-tls
  issuerRef:
    name: letsencrypt
    kind: ClusterIssuer
  dnsNames:
    - "*.demo.${DNS_ZONE}"
EOF
```

`secretName: wildcard-tls` in namespace `ingress-nginx` is what the controller's
`default-ssl-certificate` points at, so install cert-manager and issue this **before** the
controller can serve HTTPS. Watch it with:

```bash
kubectl -n ingress-nginx get certificate wildcard -w
```

Certificates renew at 60 days. A cluster asleep across that window issues a fresh one on the
next wake, which adds a minute to the first preview after a quiet spell.

**Finally, the chart's side.** `values-dev.yaml` turns off `proxy.https`, so the per-PR host
reaches the ingress through `jupyterhub.ingress`, with the hostname supplied at deploy time
because values files cannot interpolate:

```bash
ENVIRONMENT=dev NAMESPACE=pr-42 RELEASE=pr-42 ./deploy.sh \
   --set jupyterhub.ingress.hosts[0]=pr-42.demo.aiidalab.xyz
```

`values-dev.yaml` also sets `proxy.service.type: ClusterIP`. Left at the chart's default,
every preview namespace would ask Azure for a public IP of its own — which is the thing the
shared controller exists to avoid.

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

## Generating policy documents for an AiiDAlab deployment

Policy document templates are available at https://github.com/aiidalab/aiidalab-deployment-files.
Follow the instructions there to generate the policy documents for your deployment.
You can then deploy the generated documents in `basehub/files/etc/jupyterhub/templates`.
Once deployed, set `include_policies: true` under `jupyterhub.hub.config.JupyterHub.template_vars`
in that environment's values file. This gates both the `/terms-of-use` and `/privacy-policy`
routes and the links to them in the JupyterHub UI.

The generated documents are gitignored, so they must be present in the working tree at deploy
time — they are not carried by the repo.

## Configuration

Everything that describes *what* a deployment looks like is committed to this repo.
Only secrets and the Azure coordinates come from GitHub settings.

**Set these up before deploying** — the order is: create the cluster, set the secrets
and variables for the environment, then deploy.

### Values files

A deployment is always the base file plus exactly one environment file:

```
basehub/values-base.yaml            shared by every environment
basehub/values-<environment>.yaml   what makes this environment different
```

| Environment | File | Where it runs |
|---|---|---|
| `local` | `values-local.yaml` | kind, on your machine |
| `dev` | `values-dev.yaml` | per-pull-request previews |
| `staging` | `values-staging.yaml` | `staging` namespace on the production cluster |
| `production` | `values-production.yaml` | `production` namespace on the production cluster |

Helm merges the two. Dictionaries merge key by key, but **lists are replaced whole**,
so an environment that needs to change one entry of a list must restate that entire
list. This applies to `proxy.https.hosts` and to the singleuser volume mounts.

To change the title, the support address, resource limits, hostnames, the session
lifetime, or which features are enabled, edit the relevant values file and open a pull
request. The change is then reviewed, rendered in CI, and recorded in git.

### Secrets and variables kept in GitHub

A short list — everything else lives in the values files above. **Each environment has
exactly one secret**; every other entry is an identifier, and the reasoning for that is
below the tables.

Scope follows whether the value differs between environments.

**Repository scope** (Settings → Secrets and variables → Actions) — the only two that never vary:

| Name | Kind | Value |
|---|---|---|
| `AZURE_TENANT_ID` | variable | `56b508b4-59b6-40c5-9839-6c4498d10fb9` |
| `AZURE_SUBSCRIPTION_ID` | variable | `a2b00ada-7fb9-4e4f-8648-03f83044441a` |

They are repository-scoped because holding one copy beats holding three that can drift apart.
GitHub resolves environment over repository, so an environment that ever needed a different
subscription can set its own and it wins.

**Everything else is environment scope** (Settings → Environments → *name*). Expand the
environment you are setting up:

<details>
<summary><b>production</b></summary>

| Name | Kind | Value |
|---|---|---|
| `OAUTH_CLIENT_SECRET` | **secret** | from the `aiidalab-demo-production` OAuth app |
| `OAUTH_CLIENT_ID` | variable | `ec9145436c332e45df0a` |
| `OAUTH_CALLBACK_URL` | variable | `https://aiidalab-demo.materialscloud.io/hub/oauth_callback` |
| `AZURE_CLIENT_ID` | variable | `930b3bc4-8b2b-4de3-99a7-972b2a2bf7c8` (`aiidalab-demo-server-sp`) |
| `AZURE_RESOURCE_GROUP` | variable | `aiidalab-demo-server` |
| `AZURE_KUBERNETES_CLUSTER` | variable | `demo-server-production` |

</details>

<details>
<summary><b>staging</b></summary>

Staging runs in its own namespace **on the production cluster**, so the resource group and
cluster are production's. Its identity must therefore be scoped to the `staging` namespace
rather than the cluster, or a staging deploy could reach production.

| Name | Kind | Value |
|---|---|---|
| `OAUTH_CLIENT_SECRET` | **secret** | from the `aiidalab-demo-staging` OAuth app |
| `OAUTH_CLIENT_ID` | variable | from the same app |
| `OAUTH_CALLBACK_URL` | variable | `https://staging-demo.aiidalab.io/hub/oauth_callback` |
| `AZURE_CLIENT_ID` | variable | `885f29bd-b0de-4640-8593-32df45a2eb59` (`aiidalab-demo-staging-sp`) |
| `AZURE_RESOURCE_GROUP` | variable | `aiidalab-demo-server` |
| `AZURE_KUBERNETES_CLUSTER` | variable | `demo-server-production` |

</details>

<details>
<summary><b>dev</b> (per-pull-request previews)</summary>

Previews use `DummyAuthenticator`, so there are no OAuth settings at all: a GitHub OAuth app
has one callback URL and no wildcards, so a per-PR hostname could never complete a login.
The OAuth path is exercised on staging instead.

| Name | Kind | Value |
|---|---|---|
| `DUMMY_AUTH_PASSWORD` | **secret** | *choose one* — these URLs are public and a login costs a pod, so not `demo` |
| `AZURE_CLIENT_ID` | variable | *to be created* — its own identity, with no role outside the dev resource group |
| `AZURE_RESOURCE_GROUP` | variable | *to be created* |
| `AZURE_KUBERNETES_CLUSTER` | variable | *to be created* |

The teardown sweeper uses a **second, destructive-only** identity in a separate, unprotected
environment, so that cleanup is not blocked behind the deploy approval.

</details>

The rest are identifiers, not credentials. An OAuth client ID is visible in the browser's
address bar during login; a callback URL is a public address; and the Azure IDs name a
tenant, a subscription and an app registration. None of them grants access on its own —
CI authenticates to Azure over OIDC, where the trust comes from a federated credential
that names this repository and environment, not from knowing an ID.

Storing them as secrets is not more secure, and it costs something real: GitHub will not
show you a secret's value again after you save it, so a wrong one can only be replaced,
never checked. That is worth paying for a credential, and not worth paying for a GUID.

Set the environment-scoped ones at Settings → Environments → `production` / `staging`, and
the two repository-scoped ones at Settings → Secrets and variables → Actions.

Do not put anything else at repository scope. A repository variable applies to every
environment at once, which is how a value meant for production silently reaches staging —
and how the configuration came to be spread across two pages in the first place.

The OAuth apps live in the `aiidalab` organisation, named `aiidalab-demo-production` and
`aiidalab-demo-staging`. `OAUTH_CALLBACK_URL` must name the canonical host for that
environment — the first entry of `proxy.https.hosts` in its values file — because the
`oauth_state` cookie is host-scoped, and a login begun on a different host comes back
without it and JupyterHub answers **400: Bad Request**.

`OAUTH_CLIENT_SECRET` is passed to Helm on the command line by `deploy.sh` and is never
written to a file.

### Azure roles for the CI identities

The cluster uses Azure RBAC for Kubernetes Authorization, so what a CI identity may do in
the cluster is set by Azure role assignments, not Kubernetes RoleBindings. Each identity needs
two roles: one to fetch a kubeconfig, and one to act inside the cluster.

| Identity | Role | Scope |
|---|---|---|
| production `aiidalab-demo-server-sp` | `Azure Kubernetes Service Cluster User Role` | cluster |
| | `Azure Kubernetes Service RBAC Admin` | cluster |
| staging `aiidalab-demo-staging-sp` | `Azure Kubernetes Service Cluster User Role` | cluster |
| | `Azure Kubernetes Service RBAC Admin` | `namespaces/staging` |

**Use `RBAC Admin`, not `RBAC Writer`.** Writer has no rights on Roles or RoleBindings, and
the chart creates both (for the hub, the TLS proxy and the image pre-puller), so
`helm upgrade` fails with `cannot get resource "roles"` or `"clusterroles"`.

Staging's Admin role stops at its namespace, so staging cannot manage the user-scheduler's
ClusterRole. That is why `values-staging.yaml` disables the user-scheduler. Do not work around
it by granting cluster-scoped rights: an identity that can create ClusterRoleBindings can make
itself cluster-admin and reach production.

```bash
CLUSTER=$(az aks show -g aiidalab-demo-server -n demo-server-production --query id -o tsv)

az role assignment create --role "Azure Kubernetes Service RBAC Admin" \
    --assignee 930b3bc4-8b2b-4de3-99a7-972b2a2bf7c8 --scope "$CLUSTER"
az role assignment create --role "Azure Kubernetes Service RBAC Admin" \
    --assignee 885f29bd-b0de-4640-8593-32df45a2eb59 --scope "$CLUSTER/namespaces/staging"
```

Admins get kubectl access through the `AiiDAlab Admins` group, which holds
`Azure Kubernetes Service RBAC Cluster Admin` on the cluster. Subscription Owner does **not**
grant kubectl access on its own.

## Deploy

Normally you do not run this by hand. Pushing to `main` deploys staging, and publishing a
release deploys production — see
[Releasing to production](#releasing-to-production). The script below is what CI runs, and
what you use for a local cluster or a one-off.

```bash
ENVIRONMENT=staging ./deploy.sh
```

`ENVIRONMENT` picks the values file, and the namespace and Helm release name default
to it. Override them if needed — pull-request previews use `NAMESPACE=pr-42`:

```bash
ENVIRONMENT=dev NAMESPACE=pr-42 RELEASE=pr-42 ./deploy.sh
```

The namespace is created if it does not exist. In CI this same script runs from
`.github/workflows/deploy-to-aks.yml`, with the secrets above supplied from the
GitHub environment.

The external IP of the proxy can be retrieved with:

```bash
kubectl get svc proxy-public -n <namespace>
```

## For maintainers and administrators

### How deployments happen

| Trigger | Deploys | Gate |
|---|---|---|
| push to `main` | **staging** | review on the pull request |
| a published GitHub **release** | **production** | tag ruleset + required reviewers on the environment |
| `workflow_dispatch` | **staging** only | re-runs a staging deploy without an empty commit |

All three run `.github/workflows/deploy-to-aks.yml`, which authenticates to Azure with
OpenID Connect — no stored Azure credential — and then runs the same `./deploy.sh` you
would run by hand.

Each environment has its own app registration, so a staging deploy cannot use production's
identity. The federated credential's subject names the environment exactly
(`repo:aiidalab/aiidalab-demo-server:environment:staging`), so a workflow that does not
declare that environment cannot obtain a token at all.

### Releasing to production

Production deploys from **published releases**, not from a branch.

1. Check staging. It is whatever is on `main`, which is what you are about to release.
2. On GitHub, **Releases → Draft a new release**.
3. Create a tag of the form `vYYYY.MM.DD`, for example `v2026.06.01`, targeting `main`.
   For a second release on the same day, append a counter: `v2026.06.01.1`, then
   `v2026.06.01.2`.
4. **Generate release notes** — this becomes the record of what changed in production.
5. Publish. That triggers the deploy; approve it if required reviewers are configured.

Use a dot before the counter, never a hyphen: in SemVer a hyphen means *pre-release*, and
would sort the second release of the day *before* the first.

Marking a release as a **pre-release** deliberately does nothing — it will not deploy. Useful
for drafting.

Before deploying, the workflow checks that:

- the tag matches `vYYYY.MM.DD[.n]`, with real month and day ranges;
- the tagged commit is an **ancestor of `main`**, so a tag on an unreviewed commit cannot
  deploy;
- the release is not a pre-release.

It then checks out **the tag**, not a branch.

> The `production` environment's *deployment branch policy* must permit tags. A
> branches-only policy rejects a release deploy before any Azure step runs, with an error
> that looks unrelated to tags.

### Rolling back

**Cut a new release from the last good commit.** Revert the offending change on `main`, or
tag the previous good commit, and publish a release for it — `v2026.06.02` after a bad
`v2026.06.01`.

That is deliberately the only route. Nothing can deploy production except a published
release, so "what is running" and "the latest release" never drift apart. A mechanism for
deploying an older tag directly would break that: the newest release would no longer describe
production, and nothing would say so.

For a faster escape hatch that skips CI entirely:

```bash
helm -n production rollback production
```

That reverts to the previous Helm revision within seconds. It *does* break the invariant
above — the repo now disagrees with the cluster — so treat it as first aid and follow it with
a real release once the cause is understood.

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

## Local deployment for development

The same `deploy.sh` and the same values files as staging and production, pointed at a
throwaway [kind](https://kind.sigs.k8s.io/) cluster. Four commands, no extra tooling.

### Prerequisites

- Docker, running
- `kind`, `kubectl`, `helm`

### Run it

```bash
kind create cluster --name aiidalab-demo-server-local --config kind-config.yaml
ENVIRONMENT=local NAMESPACE=local ./deploy.sh
kubectl -n local rollout status deploy/hub deploy/proxy
```

Then open **http://localhost:8000** and log in with any username and the password `demo`.

No port-forwarding is needed: `kind-config.yaml` maps container port 32080 to host port
8000, and `values-local.yaml` puts the proxy on that NodePort.

No secrets are needed either. `values-local.yaml` uses `DummyAuthenticator`, so there is no
GitHub OAuth app to register. The `~2GB` singleuser image is pulled lazily, so the hub comes
up in a couple of minutes but the *first* login is slow.

`deploy.sh` refuses to deploy `ENVIRONMENT=local` unless the current kubectl context is a
kind cluster. This is deliberate: a context left pointing at a real cluster once put a
`local` release into production. Override with `ALLOW_ANY_CONTEXT=true` if you mean it.

### Applying changes while developing

Anything under `basehub/files/` is mounted from a ConfigMap, and ConfigMaps do not
hot-reload. After editing a template, a stylesheet or a script:

```bash
ENVIRONMENT=local NAMESPACE=local ./deploy.sh
kubectl -n local rollout restart deploy/hub deploy/proxy
```

Changing a values file only needs the first command.

### Tear down

```bash
kind delete cluster --name aiidalab-demo-server-local
```
