from pathlib import Path
p=Path('output/pbl_combined/build_combined.py')
s=p.read_text(encoding='utf-8-sig')
s=s.replace(' for i in indices:', ' for number,i in enumerate(indices,1):')
s=s.replace('  d.add_paragraph(p.text)', '''  elements=list(src.element.body)
  qi=i-1
  while qi>=0:
   q=Paragraph(elements[qi],src._body)
   if q.text.strip(): break
   qi-=1
  assert qi>=0
  question=f'{number}. {q.text}'
  qp=d.add_paragraph()
  qp.add_run(question).bold=True
  qp.paragraph_format.keep_with_next=True
  qp.paragraph_format.space_after=Pt(6)
  expected.append(question)
  d.add_paragraph(p.text)''')
s=s.replace("'index':i,'text':p.text", "'index':i,'question':q.text,'number':number,'text':p.text")
s=s.replace("MN522 PBL Answers Weeks 1-11.docx", "MN522 PBL Questions and Answers Weeks 1-11.docx")
p.write_text(s,encoding='utf-8')
