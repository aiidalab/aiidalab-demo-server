
# Make expects SHELL to be a path (no args). Use bash directly for portability.
SHELL := /bin/bash
.ONESHELL:
.SHELLFLAGS := -euo pipefail -c
.SILENT:

MAKEFLAGS += --no-print-directory

# Defaults (override via environment or `make VAR=value ...`)
LOCAL ?= True
CLUSTER_NAME ?= aiidalab-demo-server-local
NAMESPACE ?= local
RELEASE_NAME ?= aiidalab-demo-server
VALUES_TEMPLATE ?= basehub/values.yaml.j2
VALUES_FILE ?= ${VALUES_TEMPLATE:.j2=}
CHART_LOCK_FILE ?= basehub/Chart.lock
KIND_CONFIG_FILE ?= kind-config.yaml
HELM_DEP_RETRIES ?= 5

help: ## Show available targets
	awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_.-]+:.*##/ {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

generate-values: ## Render basehub/values.yaml from .env + Jinja2 template
	if [[ ! -f "$(VALUES_TEMPLATE)" ]]; then
		echo "Template not found: $(VALUES_TEMPLATE) (skipping)" >&2
		exit 0
	fi
	if ! command -v jinja2 >/dev/null 2>&1; then
		echo "Missing required command: jinja2" >&2
		exit 1
	fi
	if [[ -f .env ]]; then
		set -a
		source .env
		set +a
	fi
	LOCAL=${LOCAL} jinja2 "$(VALUES_TEMPLATE)" -o "$(VALUES_FILE)"
	echo "Wrote $(VALUES_FILE)"

up: _check-for-values ## Create kind cluster (if needed) and deploy helm release
	$(MAKE) _local_cmd CMD=up

refresh: _check-for-values ## Re-deploy helm release (fast; no kind create)
	$(MAKE) _local_cmd CMD=refresh

restart: ## Restart hub/proxy deployments (no helm upgrade)
	$(MAKE) _local_cmd CMD=restart

port-forward: ## Forward http://localhost:8000 -> service/proxy-public
	$(MAKE) _local_cmd CMD=port-forward

status: ## Show pods/services in the namespace
	$(MAKE) _local_cmd CMD=status

down: ## Uninstall release and delete kind cluster
	$(MAKE) _local_cmd CMD=down

clean: ## Remove generated files
	rm -f "$(VALUES_FILE)"
	rm -f "$(CHART_LOCK_FILE)"

_check-for-values:
	if [[ ! -f "$(VALUES_FILE)" ]]; then
		echo "Values file not found: $(VALUES_FILE). Run 'make generate-values' first." >&2
		exit 1
	fi

_local_cmd:
	require_cmd() { command -v "$$1" >/dev/null 2>&1 || { echo "Missing required command: $$1" >&2; exit 1; }; }
	has_cmd() { command -v "$$1" >/dev/null 2>&1; }

	ensure_helm_repos() {
		if ! helm repo list 2>/dev/null | awk 'NR>1 {print $$1}' | grep -qx "jupyterhub"; then
			helm repo add jupyterhub https://jupyterhub.github.io/helm-chart/ >/dev/null
		fi
		helm repo update >/dev/null
	}

	retry() {
		local -r attempts="$$1"; shift
		local attempt=1
		while true; do
			if "$$@"; then return 0; fi
			if [[ "$$attempt" -ge "$$attempts" ]]; then return 1; fi
			local sleep_s=$$((attempt * 5))
			echo "Retrying ($$attempt/$$attempts) after $${sleep_s}s: $$*" >&2
			sleep "$$sleep_s"
			attempt=$$((attempt + 1))
		done
	}

	kind_cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$(CLUSTER_NAME)"; }

	deploy_release() {
		echo "Deploying helm release '$(RELEASE_NAME)' into namespace '$(NAMESPACE)'"
		ensure_helm_repos
		retry "$(HELM_DEP_RETRIES)" helm dependency build basehub >/dev/null || true
		helm upgrade \
			--install \
			--cleanup-on-fail \
			--create-namespace --namespace="$(NAMESPACE)" \
			-f "$(VALUES_FILE)" \
			"$(RELEASE_NAME)" basehub
	}

	wait_ready() {
		echo "Waiting for hub and proxy to be ready..."
		kubectl -n "$(NAMESPACE)" rollout status deploy/hub --timeout=300s
		kubectl -n "$(NAMESPACE)" rollout status deploy/proxy --timeout=300s
	}

	restart_pods() {
		echo "Restarting hub and proxy deployments..."
		kubectl -n "$(NAMESPACE)" rollout restart deploy/hub
		kubectl -n "$(NAMESPACE)" rollout restart deploy/proxy
		wait_ready
	}

	case "$${CMD:-}" in
		up)
			require_cmd kubectl
			require_cmd helm
			if has_cmd kind; then
				if ! kind_cluster_exists; then
					echo "Creating kind cluster: $(CLUSTER_NAME)"
					if [[ -f "$(KIND_CONFIG_FILE)" ]]; then
						kind create cluster --name "$(CLUSTER_NAME)" --config "$(KIND_CONFIG_FILE)"
					else
						kind create cluster --name "$(CLUSTER_NAME)"
					fi
				else
					echo "Using existing kind cluster: $(CLUSTER_NAME)"
				fi
			else
				echo "kind not found; deploying to current kubectl context."
			fi
			deploy_release
			restart_pods
			echo
			echo "Next: open http://localhost:8000"
			echo "- If your kind cluster has port mappings, it should work directly."
			echo "- Otherwise, run: make port-forward"
			echo "Login with any username and password: demo"
			;;
		refresh)
			require_cmd kubectl
			require_cmd helm
			deploy_release
			restart_pods
			;;
		restart)
			require_cmd kubectl
			restart_pods
			;;
		port-forward)
			require_cmd kubectl
			echo "Forwarding service/proxy-public to http://localhost:8000 (Ctrl+C to stop)"
			kubectl -n "$(NAMESPACE)" port-forward svc/proxy-public 8000:80
			;;
		status)
			require_cmd kubectl
			kubectl -n "$(NAMESPACE)" get pods,svc
			;;
		down)
			require_cmd helm
			require_cmd kubectl
			echo "Uninstalling helm release '$(RELEASE_NAME)' from namespace '$(NAMESPACE)' (if present)"
			helm -n "$(NAMESPACE)" uninstall "$(RELEASE_NAME)" 2>/dev/null || true
			echo "Deleting namespace '$(NAMESPACE)' (if present)"
			kubectl delete namespace "$(NAMESPACE)" 2>/dev/null || true
			if has_cmd kind && kind_cluster_exists; then
				echo "Deleting kind cluster: $(CLUSTER_NAME)"
				kind delete cluster --name "$(CLUSTER_NAME)"
			fi
			;;
		*)
			echo "Unknown CMD='$${CMD:-}'. Try: make help" >&2
			exit 2 &2>/dev/null
			;;
	esac
