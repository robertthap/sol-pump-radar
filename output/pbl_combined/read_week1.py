from docx import Document
from pathlib import Path
p=Path(r'C:\Users\rober\OneDrive\Desktop\mit\Information Systyem\MN522_PBL Week1 .docx')
d=Document(p)
for i,e in enumerate(d.element.body):
 print(i,e.tag.split('}')[-1],''.join(e.xpath('.//w:t/text()')))
