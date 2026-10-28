#!/bin/sh
# Stands in for /usr/bin/security while the tests run: nothing is ever found,
# and nothing is ever stored.
case "$1" in
	find-generic-password | delete-generic-password) exit 44 ;;
esac
cat >/dev/null
exit 1
