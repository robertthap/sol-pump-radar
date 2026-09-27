import json
from pathlib import Path
fs=json.loads(Path('output/pbl_combined/sources.json').read_text(encoding='utf-8'))
for f in fs:
 if f['file']=='MN522_PBL Week1 -12 (1).docx':
  for b in f['blocks']:
   if 32<=b['i']<=48: print(b['i'],b['text'])
