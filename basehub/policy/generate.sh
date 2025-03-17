#!/bin/bash

CONFIG=config.yaml
OUTDIR=../files/etc/jupyterhub/templates

jinja2 --format=yaml terms-of-use.j2 $CONFIG >$OUTDIR/terms-of-use.html
jinja2 --format=yaml privacy-policy.j2 $CONFIG >$OUTDIR/privacy-policy.html

export INCLUDE_POLICIES=True
