#!/bin/sh
# ExecStartPre for every bb-host-daemon-* user unit: refuse to start until
# runner-ensure.sh has checked this boot that the runner identity belongs here.
# /run is tmpfs, so a fresh fork or resume always starts blocked.
[ -s /run/bb-runner/verified ] || { echo "bb runner identity not verified yet (runner-ensure.sh)" >&2; exit 1; }
