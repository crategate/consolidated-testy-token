import re
css = open('/tmp/nyseh.css').read()
rules = re.findall(r'([^{}]+)\{([^{}]*)\}', css)
def show(pat, limit=1500):
    for sel, body in rules:
        if re.search(pat, sel, re.I):
            print(f"### {sel.strip()}")
            print(body.strip()[:limit])
            print()
print("=== glitch rules ===")
show(r'glitch')
print("=== wallet rules ===")
show(r'wallet', 900)
print("=== shadow / neon / rainbow / conic ===")
show(r'conic|rainbow|neon|glow', 900)
print("=== keyframes ===")
for m in re.finditer(r'@keyframes\s+([\w-]+)\s*\{', css):
    start = m.end() - 1
    depth = 0
    i = start
    while i < len(css):
        if css[i] == '{': depth += 1
        elif css[i] == '}':
            depth -= 1
            if depth == 0: break
        i += 1
    print(f"@keyframes {m.group(1)}")
    print(css[start+1:i][:900])
    print()
