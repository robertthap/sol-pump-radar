import json
from pathlib import Path
for f in json.loads(Path('output/pbl_combined/sources.json').read_text(encoding='utf-8')):
 print('\nFILE',f['file'])
 for b in f['blocks']:
  if b['text']: print(b['i'],b['tag'],b['text'][:160])
