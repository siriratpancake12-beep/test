import sys, json, os
# 临时目录:每个写课的人在这下面用自己的子目录。不同会话的临时目录不一样,用环境变量 SCRATCH_ROOT 指定
SCRATCHROOT=os.environ.get('SCRATCH_ROOT','/tmp/yutu-scratch')
D=os.path.dirname(os.path.abspath(__file__))
R=lambda f: open(os.path.join(D,f),encoding='utf8').read()
LANG={
 'en':dict(LANGZH='英语',EXAM='剑桥 A1 Movers / A2 Key 词表、CEFR A1',NOUNRULE='名词按语言包的约定写。',
  STYLE='用地道、自然的美式英语(西雅图的大学和城市生活),口语该用缩写就用;音标用 General American,照语言包约定;noteZh 写中国学习者的难点(th、v/w、r/l、词尾辅音不加元音、连读、弱读)。'),
 'fr':dict(LANGZH='法语',EXAM='DELF A1 和 CEFR A1 词表',NOUNRULE='名词连冠词写并标性别(元音开头写成 l\' 的,features.gender 必填)。',
  STYLE='用地道、自然的法国法语(里昂的大学和城市生活);标点按法语习惯(? ! : ; 前有空格,引号用 « »);tu / vous 按 fr.md;noteZh 写中国学习者的难点(小舌音 r、u/ou、鼻化元音、不发音的词尾辅音、联诵和省音、阴阳性)。'),
 'de':dict(LANGZH='德语',EXAM='Goethe-Zertifikat A1 词表',NOUNRULE='名词首字母大写、连冠词写、标性别和复数(features.plural)。',
  STYLE='用地道、自然的德国标准德语(柏林的大学和城市生活);du / Sie 按 de.md;noteZh 写中国学习者的难点(变元音、ch、r、词尾浊辅音清化、可分动词、动词第二位的语序、名词的性)。'),
 'ja':dict(LANGZH='日语',EXAM='JLPT N5(A1)/ N4(A2)词表',NOUNRULE='有汉字的词条 features.reading 写假名读音;词条写法、不单立词条的情况按 ja.md。',
  STYLE='用自然、地道的东京标准日语(礼貌体为主;A2 起朋友之间可以用简体,按规划);有汉字的句子写 reading(整句假名,助词照写 は / へ / を);每句写 tokens(连起来等于去掉空格的原句,一句 3–10 块,切法按 ja.md 和 ja.facts.md);第 3 单元起不写 roman;第 5 单元起课文不加词间空格;人名用假名;noteZh 写中国学习者的难点(长音、促音、清浊音、高低音、和中文意思不同的汉字词)。',
  A1RULE=dict(LEVELRULE='A1 每句不超过 30 个字(不算标点和空格);',QRULE='A1 题干用中文,选项可以是中文或日语;'),
  A2RULE=dict(LEVELRULE='A2 每句不超过 45 个字(不算标点和空格);',QRULE='A2 题干用日语(promptZh 给中文),选项用日语;')),
 'ko':dict(LANGZH='韩语',EXAM='TOPIK I 1 级(A1)/ 2 级(A2)词表',NOUNRULE='动词、形容词词条写成 해요体,noteZh 注原形;汉字词在 noteZh 注汉字;同形词按意思用不同 id(看 ko.md)。',
  STYLE='用自然、地道的首尔标准韩语(해요体为主,正式场合 합니다体;朋友之间什么时候能说半语按规划);每句写 roman(国语罗马字、按实际发音、保留原句空格,规则见 ko.md);可以直接用的助词和词尾见 ko.md 第 4 条;noteZh 写中国学习者的难点(松音 / 紧音 / 送气音、收音、连音和鼻音化等音变、汉字词)。',
  A1RULE=dict(LEVELRULE='A1 每句不超过 12 个词(按空格算);',QRULE='A1 题干用中文,选项可以是中文或韩语;'),
  A2RULE=dict(LEVELRULE='A2 每句不超过 16 个词(按空格算);',QRULE='A2 题干用韩语(promptZh 给中文),选项用韩语;')),
 'es':dict(LANGZH='西班牙语',EXAM='DELE A1 和塞万提斯学院 PCIC A1 词表',NOUNRULE='名词连冠词写并标性别。',
  STYLE='用西班牙本土西语(马德里的大学和城市生活),地道、自然,¿¡ 标点齐全;拉美说法只放在 noteZh 里;tú / usted / vosotros 按 es.md;noteZh 写中国学习者的难点(大舌音、b/v、重音符号、ser/estar、阴阳性)。'),
}
A1RULE=dict(LEVELRULE='A1 每句最多 15 个词,大部分 4–10 个词;',QRULE='A1 题干用中文,选项可以是中文或外语;')
A2RULE=dict(LEVELRULE='A2 每句最多 22 个词,大部分 6–14 个词,用上 A2 的连接词让句子连起来;',QRULE='A2 题干用外语(promptZh 给中文),选项用外语;')
def brief(kind, lang, units, scratch, hf='', outfile=''):
    v={k:x for k,x in LANG[lang].items() if k not in ('A1RULE','A2RULE')}
    v.update(LANG[lang].get('A2RULE',A2RULE) if kind=='a2' else LANG[lang].get('A1RULE',A1RULE))
    v.update(SCRATCHROOT=SCRATCHROOT, LANG=lang, SCRATCH=scratch, HF=hf or '(这门语言暂时没有)', OUTFILE=outfile)
    us=list(units)
    v['UNITS']=f'{us[0]}–{us[-1]}'
    if kind=='a2':
        v['SCOPEZH']=f'A2 第 {us[0]}–{us[-1]} 单元(每单元 8 节课 + 3 篇读物)'
        v['COUNT']=str(11*len(us)); mid=R('mid-a2.md')
    elif kind=='a1':
        v['SCOPEZH']=f'A1 第 {us[0]}–{us[-1]} 单元(每单元 8 节课 + 2 篇读物)'
        v['COUNT']=str(10*len(us)); mid=R('mid-a1.md')
    else:
        v['SCOPEZH']=f'A1 第 {us[0]}–{us[-1]} 单元新增的课和读物(每单元 l06、l07 和 r01、r02)'
        v['COUNT']=str(4*len(us)); mid=R('mid-extra.md')
    lv='a2' if kind=='a2' else 'a1'
    v['ONLY']=','.join(f'{lang}.{lv}u{u}.' for u in us)
    t=R('head.md')+'\n'+mid+'\n'+R('common.md')
    for k,x in v.items(): t=t.replace('{'+k+'}',x)
    assert '{' not in t.replace('{ "','').replace('{"','') or True
    return t
if __name__=='__main__':
    kind,lang,a,b,scratch=sys.argv[1:6]
    hf=sys.argv[6] if len(sys.argv)>6 else ''
    outfile=sys.argv[7] if len(sys.argv)>7 else ''
    print(brief(kind,lang,range(int(a),int(b)+1),scratch,hf,outfile))
