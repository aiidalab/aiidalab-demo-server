# Deployment & configuration decisions

Working document, started 2026-09-21. Last updated 2026-09-23.
**DECIDED** = agreed · **PROPOSED** = on the table, unconfirmed · **OPEN** = needs an answer.

**Status:** waves 0–2 complete, staging live. Nine PRs merged. What remains: the Entra/Azure
RBAC flip (the one real open gap), production-via-release, then dev previews and hardening.

## Agenda

| # | Topic | State |
|---|---|---|
| 1 | Deployment strategy (incl. branch/promotion model) | settled; production-via-release outstanding |
| 2 | Do we still need the Jinja layer? | ✅ resolved — layer deleted |
| 3 | Hostnames + canonical-host *mechanism* | hostnames settled; per-PR hostname still open |
| 4 | One deploy path instead of two | ✅ resolved — one path |
| 5 | Chart and resource naming | not started |
| 6 | Loose ends | partly answered |

---

## 1. Deployment strategy

*Starting point (2026-09-21):* the first real validation of any change was the production
deploy itself — PRs ran no render, no `helm template`, no lint, and `main` auto-merged into a
`staging` branch whose cluster had been deleted. All of that is now fixed.

### Target tiers

| Tier | Trigger | Where | Auth | TLS | Lifetime |
|---|---|---|---|---|---|
| PR (unlabelled) | every PR | kind, in CI | dummy | none | per-run |
| PR (labelled) | `deploy-preview` label, **admin-approved per push** | dev AKS (separate cluster) | dummy, shared password | shared wildcard cert | until PR closes / nightly sleep |
| staging | push to `main` | **prod cluster, `staging` namespace** | real GitHub OAuth | chart autohttps | always on |
| production | GitHub release published | prod cluster, `production` namespace | real GitHub OAuth | chart autohttps | always on |

Dev answers "does the app work and does the page look right". Staging is the production
mirror and the only place OAuth / canonical-host / real TLS are exercised — every dev-tier
simplification is deliberate and covered by staging.

### DECIDED

**Staging shares the production cluster** in its own namespace; only dev gets a separate
cluster. Everything this repo can change is namespace-scoped, so a namespace validates
everything the repo can get wrong. Verified safe: z2jh's only cluster-scoped resources are
the user-scheduler `ClusterRole`/`ClusterRoleBinding`, both named from the release name.

Three costs accepted, with required mitigations:
1. **Credential blast radius** — no cluster boundary. *Required:* enable Azure RBAC for
   Kubernetes Authorization and scope the staging identity to
   `Azure Kubernetes Service RBAC Writer` **on the staging namespace**, not the cluster.
2. **Noisy neighbour** — *preferred fix:* separate node pool with taints/tolerations plus a
   per-namespace `ResourceQuota`.
3. **No rehearsal for cluster-level changes** (k8s upgrades, CNI, node pools). Out of band
   today; becomes a real gap once cluster config moves into Terraform.

The AKS Free control plane is $0, so sharing saves node bin-packing, not a control plane —
if (1) or (2) get painful, a separate staging cluster is cheaper than intuition suggests.

**Hostnames** — merged code on `aiidalab.io`, unmerged code on a separate registrable domain:

| Tier | Host(s) |
|---|---|
| production | `aiidalab-demo.materialscloud.io` + `demo.aiidalab.io` |
| staging | `staging-demo.aiidalab.io` |
| dev previews | `pr-N.demo.aiidalab.xyz`, wildcard `*.demo.aiidalab.xyz` |

*Why a separate registrable domain* — previews run unmerged code, and domain reputation is
shared fate: if a preview ever trips Safe Browsing or a proxy blocklist, the flag can attach
to the parent domain, where production lives. Code review doesn't help; classifiers aren't
exploits. It also removes same-site cookie sharing with production, and yields a rule that
survives staff turnover: *merged code on `aiidalab.io`, unmerged on `aiidalab.xyz`.*

*Decided 2026-09-22 after two reversals — the reasoning matters, so it isn't reopened:*
1. First `aiidalab.xyz` was rejected in favour of registering `aiidalab-dev.io`, because some
   corporate filters block `.xyz` wholesale and could stop reviewers at partner institutions.
2. Then `aiidalab-dev.io` was dropped: ~$60/yr plus a renewal obligation is not justifiable
   for a dev preview feature. The Azure zone created for it has been deleted.
3. **Final: `aiidalab.xyz`** — already owned, zone already delegated (GoDaddy → Azure), so it
   gives the isolation for **free**. The `.xyz` filtering risk is accepted; the alternative
   was `dev-demo.aiidalab.io`, i.e. no isolation at all.

Note the risk that justified isolation is substantially covered anyway by per-push admin
approval and the no-fork-previews rule — the separate domain is defence in depth, not the
primary control. Keep the `demo.` level to reserve room for other projects. A wildcard does
not cover its own parent: add `demo.aiidalab.xyz` as an explicit SAN if it should ever serve
a preview index.

⚠️ **`aiidalab.xyz` expires 2027-05-10** and is now load-bearing for previews — see
*To remember* at the end.

Four dangling A records found in this zone on 2026-09-22 have been cleared (see the audit).

**Preview gating** — two mechanisms, two jobs:
- **`deploy-preview` label** = "someone wants a preview here". A filter on which PRs raise
  approval requests. Grants nothing. (GitHub has no per-label permissions, so a label can
  never mean "admin only" — which is why it cannot be the gate.)
- **`environment: dev` with required reviewers** = an admin approves *this push*.
  The actual gate. A one-off grant would let a benign-looking PR be approved and *then* have
  bad content pushed into an auto-deploying preview; approval must track the code.

Trigger `on: pull_request`, types `[labeled, unlabeled, synchronize, reopened, closed]`.
**Not** `pull_request_target`. Fork PRs get no secrets or OIDC token, so untrusted code
cannot deploy at all — "forks are not previewed; push a branch."

*Three things must hold or the approval is decorative:*
1. **Pin the checkout to the approved SHA** (`ref: github.event.pull_request.head.sha`).
   `actions/checkout` defaults to `refs/pull/N/merge`, which GitHub **recomputes when the PR
   head moves** — an approved pending run would otherwise check out post-approval code.
2. **Azure credentials in the `development` environment**, not repo level, with the OIDC
   subject scoped to `repo:aiidalab/aiidalab-demo-server:environment:dev`.
3. **`concurrency: group: pr-<n>, cancel-in-progress: true`** — cancels *pending* runs, so
   rapid pushes collapse to one approval and admins never approve stale code.

*Teardown must bypass the gate.* Required reviewers apply to every job declaring the
environment, so cleanup would wait for an approval nobody gives and the cluster would never
sleep. Use a **second, destructive-only managed identity** (delete `pr-*` namespaces, stop
the cluster, nothing else) in an unprotected environment. The scheduled sweeper is the
**single** teardown path; PR-close cleanup is best-effort.

**Production via `release: published`**, not the `production` branch — one form creates tag
and notes and auto-generates a changelog. Protect with a tag ruleset *and*
`environment: production` required reviewers (stronger than today's ungated merge). Add
`git merge-base --is-ancestor $GITHUB_SHA origin/main` so a tag on an unreviewed commit
cannot deploy. `workflow_dispatch` with a ref input for rollback; `helm rollback` is the
faster in-cluster escape hatch. CalVer, e.g. `2026.08.01`.

**Delete `sync-staging.yml`.** Staging is by definition whatever is on `main`; the branch
adds a bot push and a thing that can conflict, and buys nothing.

### PROPOSED

- ✅ **Every PR** — done (#66). `validate.yml` lints and templates all four environments and
  installs `local` into kind **through `deploy.sh`**, so the script itself is exercised with
  every optional secret unset. No secrets, `contents: read` only, so it runs on fork PRs.
  Preview jobs should `needs:` this.
- **Dev cluster isolation:** separate RG + managed identity with **no role assignment outside
  that RG**. Converge on `vars.AZURE_*` everywhere (a client ID is not a secret).
- **Dev TLS:** one wildcard cert via cert-manager + Azure DNS DNS-01 (workload identity, no
  stored credential), shared by all PR namespaces; disable the chart's `proxy.https` on dev.
  Per-PR certs would share a Let's Encrypt bucket with production renewals — not a risk worth
  taking for a preview feature.
- **Cost / sleep:** dev cluster **stopped by default** via `az aks stop` (a System pool cannot
  scale to zero, hence stop/start). Free tier control plane. **Ephemeral OS disks** — managed
  disks bill even while stopped. Static public IP in its own RG. Deploy runs `az aks start`
  first (~10 min previews). Scheduled stop when no `pr-*` namespaces remain, **plus** a hard
  nightly stop. Ballpark under ~$10/month idle. Previews are explicitly ephemeral; the sticky
  PR comment says so and offers a way to wake them.
- **Preview lifecycle:** `helm upgrade` in place, never delete-and-recreate. Namespace =
  release name = `pr-N`. Sweeper also collects orphaned PVCs — the main way the cost estimate
  quietly breaks. Dummy-auth password from a secret, **not** `demo`: these URLs are public and
  a login is a pod.

### Intentional: a release tag does not pin the deployment

**The singleuser image floats, by design.** `IMAGE_TAG: latest` + `pullPolicy: Always`, so
the user-facing environment can change on any pod spawn with no deploy and no commit. Wanted,
not tolerated: the demo persists nothing (`storage.type: none`, cull `maxAge` 12h) so no
session is long enough to disrupt and a running pod keeps its image; and showing the latest
release *is* the point.

*Verified 2026-09-22:* `aiidalab/qe:latest` is the latest **stable release** — an explicit
manifest step in `aiidalab-qe`, gated on a `v*` tag and excluding `a`/`b`/`rc`. The default
branch publishes `edge` instead, and Docker Hub confirms the two move independently. Intent
and mechanism agree. *Upstream fragility (not ours to fix):* that filter is a substring test
on the tag name and the GHCR and Docker Hub steps use different expressions
(`github.ref` vs `github.ref_name`) — it is the only thing stopping a pre-release reaching
the demo server.

Accepted consequences: a bad published image breaks the demo with nothing to revert (the
lever is setting `IMAGE_TAG` to a known-good tag — **write it down as a procedure**), and bug
reports cannot be traced back to an image once the pod is culled.

**Per-environment config used to live in GitHub settings** (`CANONICAL_HOST`,
`SUPPORT_EMAILS`, resource limits) — ✅ resolved by wave 2 (#68). It is now in versioned
`values-<env>.yaml`, so a release pins the whole deployment *except* the deliberately floating
image, which is the right line.

### OPEN

- Does `main` → staging stay automatic once production is release-driven? (Recommend yes.)
- Same-day second release: `2026.08.01.1`, `-2`? `v` prefix or not?
- Write down the break-glass procedure for a bad published image.
- Dev cluster node size + monthly budget ceiling. Must be a `d`-suffixed size (e.g.
  `Standard_D2ds_v5`) — `D2s_v5` has no local temp disk, so it cannot use the ephemeral OS
  disks the sleep-cost model depends on.
- ✅ `scheduling.userScheduler` disabled on dev, and the image pre-puller disabled for local
  and dev (#72) — the kind job never spawns a user, so it was pulling ~2GB it never used.

---

## 2. Do we still need the Jinja layer? — RESOLVED 2026-09-23

**No.** `values.yaml.j2`, the two divergent renderers and `requirements.txt` are gone (#68,
#74). Helm merges `values-base.yaml` with one `values-<env>.yaml`; `deploy.sh` injects only
secrets. The "add the knob to the workflow `env:` block or it silently defaults" trap is gone
with it, because there is no second place to forget.

## 3. Hostnames and canonical-host mechanism — PARTLY RESOLVED

Hosts and the canonical redirect are now literal per environment in `values-<env>.yaml`, and
`CANONICAL_HOST` no longer exists as a GitHub variable. Staging renders no redirect at all
(single host), which is correct.

**Traded away:** the old template *computed* the alias list as `HOSTS` minus `CANONICAL_HOST`.
Now both are written by hand, so adding a host to `proxy.https.hosts` without also adding it
to the redirect regex gives it a certificate but no redirect — logins from it fail with 400
and nothing says why. Documented in a comment directly above the list; enforcement was judged
not worth it for two hosts.

**Still open:** dev previews need a per-PR hostname, which a literal values file cannot
express. It will have to come from `--set` at deploy time (wave 4).

## 4. One deploy path instead of two — RESOLVED 2026-09-23

There is now one path. `deploy.sh` serves every environment including local; the Makefile,
`values.yaml.j2` and `requirements.txt` are gone. Local development is four commands, works
on macOS, and exercises exactly what CI and production exercise.

*Superseded analysis, kept for the reasoning:*

`Makefile` (kind/local) and `deploy.sh` (CI/AKS) are separate implementations of the same
`helm upgrade`, and the Makefile is a shell script in a Makefile costume.

**Provenance:** the whole local-dev story — `Makefile` (181 lines), `kind-config.yaml`, the
README section, **and the `LOCAL` flag in `values.yaml.j2`** — arrived in one PR,
`daa5dd3` "Implement local deployment scheme (#48)", Edan Bainglass, 2026-02-05. So `LOCAL`
is seven months old, not original, and Wave 2's environment-model work touches this directly.

**How it was resolved.** A guard was first written into the Makefile, then reverted pending a
conversation with its author — the right call, since it was their tooling. The conversation
then changed shape: once local development became four commands of `deploy.sh`, the Makefile
had no remaining job, so it was deleted rather than repaired, and the guard moved into
`deploy.sh` where it also covers CI. The three findings that drove that:

1. **It has never worked on stock macOS.** It relies on `.ONESHELL`, introduced in GNU Make
   **3.82**; macOS ships **3.81** (2006), which ignores it silently and runs each recipe line
   in its own shell — so `require_cmd() {` is an unterminated function and every `_local_cmd`
   target dies with "syntax error: unexpected end of file". Confirmed against unmodified
   `HEAD`. Anyone on a Mac needs `brew install make` and `gmake`.
2. **It very likely caused the production incident.** Its defaults are `NAMESPACE=local`,
   `RELEASE_NAME=aiidalab-demo-server` — exactly the stray release found in the production
   cluster, dated 2026-03-31, about eight weeks after this PR landed. The old code printed
   "kind not found; deploying to current kubectl context" and carried on. ✅ Closed by #73:
   `deploy.sh` refuses `ENVIRONMENT=local` unless the context is a kind cluster.
3. **Its remaining job is narrower than it was.** Now that CI installs to kind on every PR
   (`validate.yml`), the local path's distinct value is letting a human *look at the page*.
   Worth keeping — and worth being much smaller than 181 lines. Options: a plain
   `scripts/local.sh` that works regardless of make version, or a thin Makefile shelling out
   to one. Either way the `.ONESHELL` dependency goes.

## 5. Chart and resource naming

`basehub` is inherited from 2i2c and does not describe this chart. ConfigMap names are
inconsistent (`hub-templates`, `hub-external`, `user-etc-jupyter`, `notebook-static-custom`,
`aiidalab-uptime`) and none are release-prefixed.

## 6. Loose ends

- **`PYTHON_VERSION` as a load-bearing mount path** — the singleuser assets mount at
  `/opt/conda/lib/python3.9/...`. A mismatch means `custom.js` and `custom.css` **silently**
  do not load. The version is there because the uptime extension is registered by module path
  (`notebook.static.custom.aiidalab_uptime`), so the file must sit inside the installed
  `notebook` package; and a Helm values file cannot interpolate, so it cannot become a
  variable. An issue was drafted proposing the real fix: mount version-independently, put the
  directory on `PYTHONPATH`, and use `c.NotebookApp.extra_static_paths`. **Still to be filed.**
- **A live bug on the production login page**, found while auditing config: `SUPPORT_EMAILS`
  was set with quotes inside its value, producing `mailto:"aiidalab@materialscloud.org"` — an
  invalid address. Fixed by the move to values files. The same line still hardcodes
  *"AiiDAlab PSI Server"* in the mail subject on the Materials Cloud demo server — **not
  fixed**, since it is not a variable.
- Policy HTML (`terms-of-use.html`, `privacy-policy.html`) is fetched by hand from
  `aiidalab-deployment-files` and gitignored, so it must be present in the working tree at
  deploy time. Automate or vendor?
- `admin_users` hardcoded — now in `values-base.yaml` under `Authenticator`, so at least it is
  reviewable. Still a list of names in a config file.
- `prometeus-config.yaml` — answered: it is the live `kube-prometheus-stack` config for the
  `monitoring` namespace. Typo'd name, untracked. Commit it, or accept that production
  monitoring is configured from someone's laptop.

---

# Infrastructure audit — 2026-09-22

Subscription: *Microsoft Azure Sponsorship* (`a2b00ada-…`). DNS zones `aiidalab.io` and
`aiidalab.xyz` live in RG `dns-zones`; `demo` and `staging-demo` are **records** in
`aiidalab.io`, not zones of their own.

## Production cluster — as built (authoritative; the README is not)

| | |
|---|---|
| resource group / location | `aiidalab-demo-server` / `eastus` |
| cluster / kubernetes / tier | `demo-server-production` / 1.34.6 / **Free** (no SLA) |
| cluster identity | **SystemAssigned managed identity** — not a service principal |
| node RG | `MC_aiidalab-demo-server_demo-server-production_eastus` |
| vnet / subnet | `aiidalab-demo-vnet` `10.0.0.0/8` / `aiidalab-demo-subnet` `10.240.0.0/16` |
| service CIDR / DNS IP | `10.0.0.0/16` (**inside the vnet prefix**) / `10.0.0.10` |
| network plugin / policy | azure / azure |
| `nodepool1` | 1 × `Standard_D2s_v5`, System, no autoscaling, Managed OS disk |
| `users` | 2 × `Standard_D8s_v5`, User, **autoscaling 1–7**, Managed OS disk |
| `disableLocalAccounts` | **false** — `--admin` kubeconfig works |
| Azure RBAC for k8s auth | **enabled 2026-09-24**; `aadProfile.managed: true` |
| auto-upgrade channel | `patch` (set 2026-09-22) |
| node OS upgrade channel | `NodeImage`, window Sunday 02:00 +4h utc+02:00 |
| deployment | namespace `production`, helm release `production`, chart `basehub-0.1.0` |

✅ **Both fixed 2026-09-22.** Node image upgrades had been running automatically with no
window, so nodes could reboot mid-demo; and with no channel set, AKS would have force-upgraded
whenever 1.34 left support. Both schedules now land Sunday 02:00–06:00 Berlin.

## The setup instructions need four corrections

Otherwise accurate — RG, region, vnet, subnet, CIDRs, cluster name, plugin/policy and
vm-set-type all verified correct.

1. `--service-principal` / `--client-secret` did not build this. It runs a managed identity.
   `aiidalab-demo-server-sp` is the **CI** identity, not the cluster identity.
2. **The `users` node pool is missing from both documents** — yet it serves users and carries
   the autoscaler. Biggest gap.
3. `K8S_NAMESPACE=default` is wrong; the live deployment is in `production`.
4. The DNS step is wrong: there is no `demo.aiidalab.io` zone, so "select the zone, change
   `@`" cannot work.

## Done

- **Cleanup:** deleted `rg-aiidalab-demo-dev-eastus` (stopped k8s 1.33 dev cluster),
  `aiidalab-demo-server-staging-rg`, and `aiidalab-demo-server-rg` (switzerlandnorth orphan
  vnet from the README procedure). Two stray public IPs released. Remaining `aiidalab*` RGs
  are exactly production and mmm-course.
- **Dangling DNS — five records across two zones**, each pointing at an Azure IP no longer in
  this subscription, i.e. live subdomain-takeover exposure (an attacker allocated that address
  could serve content and obtain a valid certificate for the name):
  `staging-demo.aiidalab.io` (parked on `192.0.2.1`, RFC 5737, pending the staging rebuild),
  and in `aiidalab.xyz` — `aiida-tutorial-2022-test`, `cuddly-buck`, `fresh-mink`, `qeapptest`
  (deleted with their paired ACME TXT records). Only the first was found deliberately; the
  other four surfaced by accident while choosing the preview domain. **Every A record across
  both zones is now either owned or deliberately parked.**
- The inert `aiidalab-dev.io` zone was deleted after that domain was abandoned.
- **Identity cleanup: 14 app registrations → 2.** Three held **Contributor at subscription
  root** (`aiidalab`, `aiidalab-demo-server`, `terraform-aiidalab`) — expired secrets only, but
  anyone with app-owner rights could mint a new one and hold subscription-wide Contributor.
  `azure-cli-2025-09-12-08-11-25` (the signature of `create-for-rbac` without `--name`) held
  Contributor over production. `aiidalab-sp` carried a federated credential for
  `repo:unkcpz/…:environment:production` — a standing grant from a **personal fork** into
  production. Kept: `aiidalab-demo-server-sp` (production CI) and `aiidalab-mmm-course-sp`.
  *Accepted, not fixed:* five orphaned role assignments remain ("Identity not found");
  deleting an app does not remove its role assignments. Judged fine — the apps purge from
  soft-delete in 30 days and nobody will restore them.

## Standing requirements this produced

- **Public IPs must live in a durable RG, not the AKS-managed node RG.** `demo.aiidalab.io`
  points at an IP inside `MC_…`, which is destroyed with the cluster — production has the same
  latent dangling-DNS exposure, just untriggered. Pre-create the IPs and adopt them via the
  `azure-load-balancer-resource-group` annotation. Applies to every tier.
- **Narrow the production CI identity.** `aiidalab-demo-server-sp` has `Contributor` on the
  *managed cluster resource*, so CI can delete the cluster — and with local accounts enabled it
  can pull admin kubeconfig. It needs `Azure Kubernetes Service Cluster User Role` plus
  Kubernetes-level RBAC. Same narrowing already agreed for staging.
- **`aiidalab-mmm-course-sp` authenticates with a client secret**, not OIDC. It will expire.

## Found in the cluster

- ✅ **Removed:** the stray `local` release (a local-dev deploy that reached production in
  March, `hub` at zero ready replicas) and the orphaned `default` release from 2024. The cause
  is closed too — see topic 4.
- Namespace `pvc-speed-test` looks like a leftover; worth confirming and removing.
  (`aks-command` is created by `az aks command invoke` and reappears on demand — leave it.)
- **Terraform was started in 2022 and abandoned.** RG `tfstate`, storage `tfstate6452`,
  container `tfstate`; the `terraform-aiidalab`/`terraform-bot` apps were both created
  2022-05-05. Contents unreadable without a Storage Blob Data role. Archaeology, not a
  handover — look before writing new infrastructure code.

## Recommended shape for cluster work

Keep cluster `apply` manual — an automated pipeline that can destroy a cluster is worse than a
manual one that can't. The problem is the missing **record**, not the missing automation:
every surprise above came from a hand-made change that left no artifact. So: desired state in
a file, `terraform plan` in CI on PRs *and* on a schedule, `apply` by hand. The milestone worth
aiming at is `plan` showing **zero diff** against the imported production cluster.

Order: fix the current setup manually (logging each change) → make the README true → import
into Terraform → build the dev cluster *from* the file, where the static-IP pattern can be
rehearsed at no risk.

## Plan

Ordering principle: external lead time first, then whatever makes later work *safe*, then the
risky work. The variable/environment model comes before staging or dev because neither can be
expressed correctly without it.

**Wave 0 — quick wins, no dependencies — DONE 2026-09-22**
Domain resolved without purchase (`aiidalab.xyz`); maintenance windows set (both schedules,
Sunday 02:00 +4h utc+02:00); auto-upgrade channel set to `patch`; stray `local` and `default`
helm releases removed; clusters, DNS and identities cleaned (see audit).

**Wave 1 — make the repo safe to change** — DONE 2026-09-23

Resolved differently than planned. Item 1 landed as `validate.yml` (#66). Item 2 — the
Makefile footgun — was not fixed but *removed*: once local development became
`kind create cluster` + `ENVIRONMENT=local ./deploy.sh`, the Makefile had no remaining job,
so it was deleted along with `values.yaml.j2` and `requirements.txt` (#74). The guard moved
into `deploy.sh` instead (#73), where it also protects the CI path — the hazard was never
really the Makefile's, it was that nothing checked which cluster was being targeted.

*Original plan:*
1. ✅ **DONE 2026-09-22** — PR validation in CI (`.github/workflows/validate.yml`): renders both
   value shapes, checks they parse, `helm template` + `helm lint`, asserts the two renderers
   agree, then installs into kind and waits for hub + proxy rollout, with diagnostics on
   failure. No secrets and no privileged permissions, so it runs on fork PRs.
   *Deliberately before Wave 2* — that refactor is the riskiest change to this repo.
2. ⏸ **Blocked, by choice** — the Makefile footgun. Guard written, tested and reverted pending
   a conversation with its author. See topic 4.

**Wave 2 — the keystone: variables and the environment model** — IMPLEMENTED 2026-09-22/23

Config moved from GitHub settings into committed values files: `basehub/values-base.yaml`
plus one `values-<environment>.yaml` per environment, merged by Helm. `deploy.sh` takes
`ENVIRONMENT` and injects only secrets, on the command line, never to disk. The environment
enum ended up as *file names* rather than a template variable, which removed the need for the
Jinja layer on every deployed path.

Verified equivalent: `helm template` against the new files differs from the old render only in
the four intended ways (admin_users on the `Authenticator` base class, `template_vars` as
declarative config instead of generated Python, `include_policies` read from `template_vars`,
policy handler classes always defined but conditionally registered). A `--dry-run` upgrade
against the live production release succeeded.

These GitHub settings are now dead and should be **deleted** once merged: repository variables
`CONTAINER_LIFETIME`, `INCLUDE_QE`, `IS_MC_DEPLOYMENT`, `PYTHON_VERSION`, `SUPPORT_EMAILS`;
environment variables `CANONICAL_HOST`, `K8S_NAMESPACE`.

✅ Both follow-ups landed: `validate.yml` now lints and templates all four environments and
installs `local` through `deploy.sh` (#66), and the Makefile plus `values.yaml.j2` were
deleted outright rather than migrated (#74).

**One bug this shipped, caught in production use rather than review:** `deploy.sh`'s secret
helper used `[[ -n "$v" ]] && args+=(...)`, so an empty optional secret made the function
return non-zero and `set -e` killed the script — exit 1, empty log, two seconds. Every
environment leaves at least one optional secret unset, so *no* deployment could have
succeeded. The `validate.yml` kind job now covers exactly this case.

*Original plan, for reference:*
3. Replace `LOCAL` + namespace-derived `STAGING` with a single `ENVIRONMENT`
   (`local|dev|staging|production`); everything else derives from it. Extra input `PR_NUMBER`
   for dev → namespace `pr-N`, host `pr-N.demo.aiidalab.xyz`. Two booleans encoding one enum is
   why the dev tier cannot be expressed today.
4. Decide where config lives (topic 2). *Recommendation:* move per-environment config out of
   GitHub repo variables into versioned `values-<env>.yaml` — `CANONICAL_HOST`,
   `SUPPORT_EMAILS`, CPU/memory, `TITLE`/`SUBTITLE`, `INCLUDE_*`, `IS_MC_DEPLOYMENT`,
   `PYTHON_VERSION`, hosts. Leave only real secrets and Azure coordinates in GitHub. Then a
   release pins the whole deployment except the deliberately floating image, and the
   "forgot to add the knob to the workflow `env:` block" trap disappears.

   *Needs discussion before any code is written.*

**Wave 3 — staging** — COMPLETE 2026-09-24

Staging deploys automatically from `main` and serves https://staging-demo.aiidalab.io with a
valid certificate. `sync-staging.yml` is gone; the `staging` branch can be deleted.

Identity: `aiidalab-demo-staging-sp` (`885f29bd-b0de-4640-8593-32df45a2eb59`), federated on
`repo:aiidalab/aiidalab-demo-server:environment:staging`, holding only
`Azure Kubernetes Service Cluster User Role` on the production cluster — deliberately less
than production's Contributor.

Snags worth remembering:
- The `staging` GitHub environment had a **deployment branch policy** still naming the old
  `staging` branch, so `main` was refused before any Azure step ran. Repointed to `main`,
  which also blocks `workflow_dispatch` from other branches — accepted; that is what dev
  previews are for.
- `deploy.sh` died silently (exit 1, empty log, 2s) because its secret helper used
  `[[ -n "$v" ]] && args+=(...)`: an empty optional secret made the function return non-zero
  and `set -e` killed the script. Every environment leaves at least one optional secret
  unset, so no deployment could have succeeded — production included. Fixed with an explicit
  `if`. **The `validate.yml` kind job would have caught this**, which is the argument for
  landing that follow-up.
- First certificate attempt failed with `no valid A records` because the record was still
  parked on `192.0.2.1` (RFC 5737 is rejected by Let's Encrypt). Fixed by repointing DNS and
  restarting `autohttps`.

**✅ CLOSED 2026-09-24.** `az aks update --enable-aad --enable-azure-rbac` is done. The
namespace boundary is now real, not nominal.

Verified, rather than assumed — `kubectl auth can-i --as=` does not work here (the Azure
webhook needs an `oid` extra that kubectl has no flag for), so the proof was a
`SubjectAccessReview` carrying `extra.oid`:

| Identity | `staging` ns | `production` ns |
|---|---|---|
| staging CI (`885f29bd`) | **allowed**, citing the role assignment | **denied** get/create/delete |
| production CI (`930b3bc4`) | allowed | allowed (cluster-scoped, as intended) |

No disruption: two users spawned *during* the change window, because the hub talks to the API
with an in-cluster ServiceAccount, which Azure RBAC does not govern. Human and CI access is
what changed.

*Prepared, inert until the flip:*
- Role assignments in place — `AiiDAlab Admins` → `RBAC Cluster Admin` on the cluster (the
  lock-out insurance; note subscription Owner does **not** grant kubectl access once Azure RBAC
  is on, so without this every admin would see `Forbidden`); prod CI → `RBAC Writer` on the
  cluster; staging CI → `RBAC Writer` on **`.../namespaces/staging`** only.
- `kubelogin` in the deploy workflow (#71), pinned to `v0.2.19` — resolving `latest` calls the
  GitHub API and fails without a token. Verified a no-op against a certificate-based
  kubeconfig, which is why it could merge before the flip.

*The flip:* `az aks update --enable-aad --enable-azure-rbac`. Every existing kubeconfig stops
working; re-run `az aks get-credentials`, then `kubelogin convert-kubeconfig -l azurecli`.
Verify in order: staging deploys → the staging identity is **FORBIDDEN** in the production
namespace (the test that proves the isolation) → production deploys. Rollback is
`--disable-azure-rbac`; `--admin` works throughout since local accounts stay enabled. Closing
that bypass with `--disable-local-accounts` is a separate, later call.

*Deferred by choice (2026-09-23):* the **tag ruleset** restricting who may create `v*` tags.
Required reviewers on the `production` environment is the actual deploy gate, so the ruleset is
not load-bearing for security. What it would add is **tag immutability** — without it a release
tag can be deleted and recreated pointing elsewhere, and the release history quietly stops
describing what was deployed. Worth doing eventually in a repo that exists to be that record.

✅ **Production now deploys from published releases** (`vYYYY.MM.DD[.n]`), not a branch. The
workflow validates the tag format, checks the commit is an ancestor of `main`, skips
pre-releases, and checks out the tag. `workflow_dispatch` can only reach staging.

**No rollback mechanism, deliberately.** Rollback is cutting a new release from the last good
commit, which keeps "what is running" and "the latest release" the same thing. A path for
deploying an older tag would let those drift silently. `helm rollback` remains as first aid.

The `production` branch is now unused and can be deleted once one release has gone out cleanly.

*Untested until it next runs:* `kubelogin` inside Actions. Local verification used `-l azurecli`
against a human `az login`; CI uses the same mode with the federated credential. A failure
shows up at `Connect to AKS` with a clear error.

**Wave 4 — dev previews**

*Settled 2026-09-24:*
- **The word is `dev`, everywhere.** GitHub environment `dev`, OIDC subject
  `repo:aiidalab/aiidalab-demo-server:environment:dev`, and `values-dev.yaml`. The first two
  must match *exactly* or Azure returns `AADSTS70021`, which names neither side. The third is
  a separate coupling (to the filename) but sharing one word removes a thing to get wrong.
  Rename the stray `development` in the old `deploy-pr-to-dev-server.yml` stub.
- Teardown gets its own GitHub environment, `dev-cleanup`, unprotected — required reviewers
  apply to every *job* declaring an environment, so a cleanup job sharing `dev` would wait for
  an approval nobody gives and previews would never be removed.
  **Revised 2026-09-25: one identity, two federated credentials**, not two identities. Deleting
  a namespace requires Cluster Admin, so a teardown identity cannot be given narrower rights —
  the split buys a different approval gate, not less privilege, and a second app registration
  with identical role assignments would only be more to maintain.
- **Node size `Standard_D2ds_v5`** — 1–2 testers. The `d` is load-bearing: non-`d` sizes have
  no local temp disk and cannot use ephemeral OS disks, which the sleep-cost model needs.
- **Wake on an approved preview deploy**, not on every commit. `az aks start` at the top of
  that job. A commit to an unlabelled PR then costs nothing, and the approval gate stays the
  thing that decides when Azure spends money.
- **Sleep on two rules:** hourly, stop when no `pr-*` namespaces remain; plus a hard daily stop
  at **03:00 Europe/Zurich**. The hourly rule is what makes it cheap — a nightly stop alone
  means one 9am preview costs ~18 hours. The daily stop is the backstop for a forgotten open
  PR. *Note:* GitHub cron is UTC and ignores DST, so `0 1 * * *` is 03:00 in summer and 02:00
  in winter. Harmless at that hour.

*Constraint found 2026-09-24 — dev's deploy identity needs Cluster Admin.* Neither
`Azure Kubernetes Service RBAC Writer` nor `RBAC Admin` can create a namespace: Writer does not
list namespaces among its dataActions, and Admin explicitly excludes `namespaces/write` and
`namespaces/delete`. Previews create and delete `pr-N` namespaces, so dev's identity needs
**RBAC Cluster Admin on the dev cluster**. Tolerable only because dev is a cluster of its own —
which is the isolation boundary, rather than the role being it.

The same limitation has a consequence for **staging**: its identity is scoped to
`namespaces/staging`, so if that namespace is ever deleted, CI **cannot recreate it**. It has
to be recreated with an admin credential first.

*The gap the original plan missed: nothing routes the hostname.* Wildcard DNS resolves every
`pr-*` name to one address, so per-namespace `LoadBalancer` services cannot work — they would
all collide on whichever owns the IP. Dev needs **one ingress controller**, one static IP, and
an `Ingress` per namespace routing by `Host`. The chart supports this
(`jupyterhub.ingress.enabled`/`hosts`), and `--set jupyterhub.ingress.hosts[0]=pr-N…` at deploy
time is also how the per-PR hostname finally gets in, since values files cannot interpolate.
Give the controller a **default SSL certificate** pointing at the wildcard secret, so no per-PR
namespace needs a copy of it — otherwise the wildcard has to be replicated into every
namespace, which needs another moving part.

*Order (DNS first — slowest to verify, independent of everything else):*
9.  ✅ **Done 2026-09-24**, except the certificate (needs a cluster):
    - RG **`aiidalab-networking`** (eastus) — durable, shared across tiers, deliberately *not*
      a cluster's RG so public IPs survive cluster rebuilds. This is the standing requirement
      from the `demo.aiidalab.io` finding, applied for the first time.
    - Static public IP **`dev-ingress` = `20.163.208.33`** (Standard SKU, required by AKS's
      Standard load balancer).
    - Wildcard **`*.demo.aiidalab.xyz` → `20.163.208.33`**, TTL 300. Verified authoritatively:
      `pr-42.demo.aiidalab.xyz` and `anything.demo.aiidalab.xyz` both resolve.
    - Region **eastus**, chosen for cost. Fixes the dev cluster's region too, since the static
      IP must match its load balancer.
    - *Still to do:* cert-manager with an Azure DNS DNS-01 solver, issuing `*.demo.aiidalab.xyz`.
      Needs the cluster, and needs the cluster identity to hold **DNS Zone Contributor** on the
      `aiidalab.xyz` zone.
10. ✅ **Done 2026-09-26.** RG/cluster `aiidalab-demo-dev` (eastus, `Standard_D2ds_v5`,
    ephemeral OS disk 64 GiB, Free tier, k8s 1.35, Entra + Azure RBAC + workload identity on).
    One identity `aiidalab-demo-dev-sp` with two federated credentials (`dev`, `dev-cleanup`),
    holding Cluster User Role + RBAC Cluster Admin on the cluster.
11. ✅ **Done 2026-09-26.** ingress-nginx on the reserved IP `20.163.208.33`, cert-manager with
    a workload-identity DNS-01 solver, and a Let's Encrypt wildcard for `*.demo.aiidalab.xyz`
    serving as the controller's default certificate. Verified from outside the office network:
    `https://pr-1.demo.aiidalab.xyz` returns nginx's 404 over a trusted certificate.

    *Four defects in the written procedure, all found by running it:* the ephemeral OS disk
    must be sized to the VM's temp disk (75 GiB on `D2ds_v5`, against a 128 GiB default);
    workload-identity labels need `--set-string`, since Kubernetes rejects boolean label
    values; AKS turns ingress-nginx's `appProtocol` into HTTP probes against `/`, where nginx
    answers 404 and the node is marked unhealthy — the health-probe path annotation is not
    optional; and the controller must be restarted after the certificate is issued, because it
    starts before the secret exists and a `helm upgrade` does not replace the pod.
12. Preview workflow: label filter, per-push approval, SHA-pinned checkout, concurrency,
    `az aks start`, `--set` the per-PR host and namespace.
13. Sweeper + the two stop rules — before anyone relies on previews, or the cost model breaks
    quietly.

**Wave 5 — production hardening and the record**
14. Apply the static-IP pattern to production (closes the dangling-DNS exposure `demo` still has).
15. Narrow `aiidalab-demo-server-sp` to `Cluster User Role` + Kubernetes RBAC.
16. Rewrite the README from the verified cluster table — *after* the cluster stops changing.
17. Terraform: inspect the 2022 state, then import production until `plan` shows zero diff.

## Merged 2026-09-23

| PR | |
|---|---|
| #68 | config moved from GitHub settings into `values-base.yaml` + `values-<env>.yaml` |
| #70 | `main` deploys staging; `sync-staging.yml` deleted |
| — | `deploy.sh` secret-helper fix (silent exit 1) |
| #71 | `kubelogin` in the deploy workflow, pinned |
| #66 | `validate.yml` — lint/template all environments, install to kind via `deploy.sh` |
| #73 | `deploy.sh` refuses `local` outside a kind cluster |
| #72 | no image pre-pull for local and dev |
| #74 | Makefile, `values.yaml.j2` and `requirements.txt` deleted |

Local development is now:

```
kind create cluster --name aiidalab-demo-server-local --config kind-config.yaml
ENVIRONMENT=local NAMESPACE=local ./deploy.sh
```

Same script, same values files as staging and production — and it works on macOS, which the
Makefile never did.

## Repo hygiene

- **`CLAUDE.md` is now actively wrong** — it documents Makefile targets, the Jinja render flow
  and `values.yaml.j2` as the source of hostnames and template variables, none of which exist.
  It is untracked, so no PR touched it, and it is what steers future sessions here.
- **This file is untracked too.** It is the only record of *why* — the reversals, the accepted
  gaps, the things deliberately not fixed. Decide whether it belongs in the repo.
- **Stale branches** on `origin`: `production-my`, plus merged `chore/*`, `ci/*`, `tests/*`,
  `safeguard/*`, `feature/*`, `fix/*`, `update/*`. On `upstream`: `staging` (now unused),
  `xing-prs`, `unkcpz-patch-1`.
- `prometeus-config.yaml` still untracked — it is the live `kube-prometheus-stack` config.

## To remember

- **Confirm auto-renew on `aiidalab.xyz` at GoDaddy.** Expires **2027-05-10** and is now
  load-bearing for dev previews. Domain expiry is the silent failure mode: everything works
  until it abruptly doesn't, and nobody is watching. Same check is worth doing for
  `aiidalab.io` (expires 2034-05-10, so less urgent).
- **`patch` defers minor upgrades, it does not remove them.** AKS will still force
  1.34 → 1.35 when 1.34 leaves support. Needs to be a deliberate, scheduled task — and with
  staging sharing the production cluster there is nowhere to rehearse it.
- **Add a scheduled dangling-DNS check.** Five exposures were found in one afternoon, and only
  one of them by looking. A scheduled job comparing every A record in `dns-zones` against
  `az network public-ip list` is a few lines and would have caught all five. Public IPs
  living in AKS-managed node RGs make this recurring, not one-off — see *Standing requirements*.

## Long poles (start early, independent of everything else)

1. Wildcard record on the existing `aiidalab.xyz` zone + cert-manager DNS-01 role assignment.
   (No registration needed — domain already owned and delegated.)
2. Static public IPs reserved in a durable resource group.
3. Dev RG and **two** managed identities: `dev` (OIDC subject `…:environment:dev`, behind
   required reviewers) and `dev-cleanup` (destructive only, unprotected environment).
4. ✅ Role assignments done; only the flip itself remains — see wave 3.
