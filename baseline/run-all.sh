#!/bin/sh
# Runs every baseline suite against the scripted mock model server. No network, no real model.
cd "$(dirname "$0")"
mkdir -p results
for t in t00-smoke t01-multi-cwd t02-queue t03-tools t04-context t04b-timeouts-trust t05-mcp t05b-mcp-lifecycle t06-subagents t07-misc; do
  node --expose-gc "tests/$t.mjs" > "results/$t.log" 2>&1
  echo "$t exit=$?"
done
