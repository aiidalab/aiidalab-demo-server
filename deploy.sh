#!/bin/bash

helm dependency build basehub 2> /dev/null || echo "No dependencies to update or install"

# JupyterHub
helm upgrade \
	--install \
	--cleanup-on-fail \
	--create-namespace --namespace=${K8S_NAMESPACE} \
	${K8S_NAMESPACE} basehub
