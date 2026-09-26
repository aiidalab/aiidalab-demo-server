#!/bin/bash
#
# Deploy one environment.
#
#   ENVIRONMENT=production ./deploy.sh
#
# Configuration is the base values file plus exactly one environment file, both
# committed to the repo. Only secrets come from the outside, as environment
# variables, and they are never written to disk.
#
# Optional overrides:
#   NAMESPACE   defaults to $ENVIRONMENT   (dev previews use pr-<n>)
#   RELEASE     defaults to $NAMESPACE
#   ALLOW_ANY_CONTEXT  set to true to deploy 'local' to a non-kind cluster
#
# Any further arguments are passed straight to `helm upgrade`. That is how
# per-pull-request values reach the chart, since values files cannot interpolate:
#
#   ENVIRONMENT=dev NAMESPACE=pr-42 ./deploy.sh \
#       --set jupyterhub.ingress.hosts[0]=pr-42.demo.aiidalab.xyz
#
set -euo pipefail

: "${ENVIRONMENT:?ENVIRONMENT must be set (local | dev | staging | production)}"

CHART="basehub"
VALUES_BASE="${CHART}/values-base.yaml"
VALUES_ENV="${CHART}/values-${ENVIRONMENT}.yaml"

if [[ ! -f "${VALUES_ENV}" ]]; then
	echo "Unknown environment '${ENVIRONMENT}': ${VALUES_ENV} does not exist." >&2
	echo "Available:" >&2
	ls "${CHART}"/values-*.yaml | sed 's#.*/values-##; s#\.yaml##' | grep -v '^base$' | sed 's#^#  #' >&2
	exit 1
fi

NAMESPACE="${NAMESPACE:-${ENVIRONMENT}}"
RELEASE="${RELEASE:-${NAMESPACE}}"
CONTEXT="$(kubectl config current-context 2>/dev/null || true)"

# The 'local' environment exists only for a throwaway kind cluster. Nothing else
# in this script cares which cluster it is talking to, so without this check a
# kubectl context left pointing at a real cluster turns a local test into a
# deploy there. That is exactly how a stray 'local' namespace once ended up in
# the production cluster.
if [[ "${ENVIRONMENT}" == "local" && "${ALLOW_ANY_CONTEXT:-false}" != "true" ]]; then
	if [[ "${CONTEXT}" != kind-* ]]; then
		echo "Refusing to deploy the 'local' environment." >&2
		echo "  current kubectl context: '${CONTEXT:-<none>}'" >&2
		echo "  expected a kind cluster (a context named 'kind-...')." >&2
		echo >&2
		echo "Create one with:" >&2
		echo "  kind create cluster --name aiidalab-demo-server-local --config kind-config.yaml" >&2
		echo >&2
		echo "If you really mean to deploy 'local' elsewhere, re-run with" >&2
		echo "ALLOW_ANY_CONTEXT=true." >&2
		exit 1
	fi
fi

helm dependency build "${CHART}" >/dev/null

args=(
	upgrade --install
	--cleanup-on-fail
	--create-namespace --namespace "${NAMESPACE}"
	-f "${VALUES_BASE}"
	-f "${VALUES_ENV}"
)

# Secrets are passed on the command line rather than rendered into a file, so
# they never exist on disk. Each is optional: environments using dummy auth have
# no OAuth credentials, and vice versa.
# Note the explicit `if` rather than `[[ ... ]] && ...`: under `set -e` a function
# whose last command is a failed test returns non-zero and kills the script, which
# is exactly what an unset optional secret would do.
secret() {
	local value="${2:-}"
	if [[ -n "${value}" ]]; then
		args+=(--set-string "$1=${value}")
	fi
}
secret jupyterhub.hub.config.GitHubOAuthenticator.client_id "${OAUTH_CLIENT_ID:-}"
secret jupyterhub.hub.config.GitHubOAuthenticator.client_secret "${OAUTH_CLIENT_SECRET:-}"
secret jupyterhub.hub.config.GitHubOAuthenticator.oauth_callback_url "${OAUTH_CALLBACK_URL:-}"
secret jupyterhub.hub.config.DummyAuthenticator.password "${DUMMY_AUTH_PASSWORD:-}"

echo "Deploying '${RELEASE}' (${ENVIRONMENT}) into namespace '${NAMESPACE}' on context '${CONTEXT:-<none>}'"
if [[ $# -gt 0 ]]; then
	echo "  extra helm arguments: $*"
fi
helm "${args[@]}" "${RELEASE}" "${CHART}" "$@"
