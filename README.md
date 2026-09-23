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
| `AZURE_CLIENT_ID` | variable | *to be created* — staging has no app registration yet |
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
| `workflow_dispatch` | either | choose the environment, and optionally a ref |

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

Deploy an earlier tag — **Actions → Deploy to AKS → Run workflow**, set the environment to
`production` and `ref` to the tag you want.

For a faster in-cluster escape hatch that skips CI entirely:

```bash
helm -n production rollback production
```

That reverts to the previous Helm revision. It does not change what the repo says is
deployed, so follow it with a real release once the cause is understood.

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
