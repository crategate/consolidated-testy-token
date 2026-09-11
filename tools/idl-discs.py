#!/usr/bin/env python3
import json
d = json.load(open('target/idl/crank_oracle.json'))
for ix in d['instructions']:
    print(f"{ix['name']:22s} disc {bytes(ix['discriminator']).hex()}")
for a in d['accounts']:
    print(f"account {a['name']:14s} disc {bytes(a['discriminator']).hex()}")
