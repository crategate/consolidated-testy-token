#!/usr/bin/env python3
import json, sys
a = json.load(open('/tmp/crank_idl_backup.json'))
b = json.load(open('target/idl/crank_oracle.json'))

def key(d, k):
    return d.get(k)

print("=== metadata ===")
print("frozen:", a.get('metadata'))
print("new   :", b.get('metadata'))

print("=== instructions ===")
fa = {ix['name']: ix for ix in a['instructions']}
fb = {ix['name']: ix for ix in b['instructions']}
print("names frozen:", sorted(fa), "count", len(fa))
print("names new   :", sorted(fb), "count", len(fb))
for name in sorted(set(fa) | set(fb)):
    if name not in fa or name not in fb:
        print(f"  {name}: {'FROZEN-ONLY' if name in fa else 'NEW-ONLY'}")
        continue
    x, y = fa[name], fb[name]
    if x['discriminator'] != y['discriminator']:
        print(f"  {name}: DISC CHANGED {bytes(x['discriminator']).hex()} -> {bytes(y['discriminator']).hex()}")
    xa = [(p['name'], p['type']) for p in x['args']]
    ya = [(p['name'], p['type']) for p in y['args']]
    if xa != ya:
        print(f"  {name}: ARGS {xa} -> {ya}")
    xac = [ac['name'] for ac in x['accounts']]
    yac = [ac['name'] for ac in y['accounts']]
    if xac != yac:
        print(f"  {name}: ACCOUNTS {xac} -> {yac}")

print("=== accounts ===")
ga = {ac['name']: ac for ac in a['accounts']}
gb = {ac['name']: ac for ac in b['accounts']}
for name in sorted(set(ga) | set(gb)):
    if name not in ga or name not in gb:
        print(f"  {name}: {'FROZEN-ONLY' if name in ga else 'NEW-ONLY'}")
        continue
    x, y = ga[name], gb[name]
    if x['discriminator'] != y['discriminator']:
        print(f"  {name}: DISC CHANGED")
    xf = [(f['name'], f['type']) for f in x['type']['fields']]
    yf = [(f['name'], f['type']) for f in y['type']['fields']]
    if xf != yf:
        print(f"  {name}: FIELDS {xf} -> {yf}")

print("=== errors ===")
ea = {(e['code'], e['name']) for e in a['errors']}
eb = {(e['code'], e['name']) for e in b['errors']}
print("only-frozen:", ea - eb, "only-new:", eb - ea)

print("=== top-level keys ===")
print("frozen:", sorted(a.keys()))
print("new   :", sorted(b.keys()))
