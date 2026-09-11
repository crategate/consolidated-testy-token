import json

idl = json.load(open('target/idl/amm.json'))
mm = [a for a in idl['accounts'] if a['name'] == 'MarketMetrics'][0]
print('MarketMetrics account def:', json.dumps(mm))
# The type lives in idl['types']
for t in idl.get('types', []):
    if t['name'] in ('MarketMetrics', 'AmmState'):
        print(t['name'], 'fields:', [f['name'] for f in t['type']['fields']])
c = json.load(open('target/idl/crank_oracle.json'))
for t in c.get('types', []):
    if t['name'] == 'MarketStatus':
        print('crank MarketStatus fields:', [f['name'] for f in t['type']['fields']])
