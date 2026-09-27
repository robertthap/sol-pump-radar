from pathlib import Path
from docx import Document
import json
root=Path(r'C:\Users\rober\OneDrive\Desktop\mit\Information Systyem')
out=[]
for p in root.glob('*.docx'):
 if 'pbl' in p.name.lower() or p.name=='MN624 Laboratory 5.docx':
  d=Document(p)
  blocks=[]
  for i,e in enumerate(d.element.body):
   texts=e.xpath('.//w:t')
   text=''.join(t.text or '' for t in texts)
   blocks.append({'i':i,'tag':e.tag.split('}')[-1],'text':text})
  out.append({'file':p.name,'blocks':blocks})
Path(r'C:\Users\rober\sol-pump-radar\output\pbl_combined\sources.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
for f in out:
 print('\nFILE',f['file'])
 for b in f['blocks']:
  print(b['i'],b['tag'],b['text'])
