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
secret() {
	local value="${2:-}"
	[[ -n "${value}" ]] && args+=(--set-string "$1=${value}")
}
secret jupyterhub.hub.config.GitHubOAuthenticator.client_id "${OAUTH_CLIENT_ID:-}"
secret jupyterhub.hub.config.GitHubOAuthenticator.client_secret "${OAUTH_CLIENT_SECRET:-}"
secret jupyterhub.hub.config.GitHubOAuthenticator.oauth_callback_url "${OAUTH_CALLBACK_URL:-}"
secret jupyterhub.hub.config.DummyAuthenticator.password "${DUMMY_AUTH_PASSWORD:-}"

echo "Deploying '${RELEASE}' (${ENVIRONMENT}) into namespace '${NAMESPACE}'"
helm "${args[@]}" "${RELEASE}" "${CHART}"
