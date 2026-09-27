from docx import Document
p=r'C:\Users\rober\OneDrive\Desktop\mit\Information Systyem\MN522_PBL Week1 (1).docx'
d=Document(p)
for i,e in enumerate(d.element.body):
 t=''.join(e.xpath('.//w:t/text()'))
 if t: print(i,t)
 if i>55: break
