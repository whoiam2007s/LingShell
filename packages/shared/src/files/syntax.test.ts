import { describe, it, expect } from 'vitest'
import { syntaxLangOf, tokenizeLine, highlightText, type SyntaxLang, type Tok } from './syntax.js'

const kinds = (toks: Tok[]) => toks.filter((t) => t.kind).map((t) => `${t.kind}:${t.text}`)
const LANGS: SyntaxLang[] = ['shell', 'ini', 'nginx', 'yaml', 'json', 'xml', 'dockerfile', 'sql', 'code', 'python', 'plain']

describe('syntaxLangOf', () => {
  it('按文件名认语言', () => {
    expect(syntaxLangOf('/etc/nginx/nginx.conf')).toBe('nginx')
    expect(syntaxLangOf('/etc/nginx/conf.d/app.conf')).toBe('nginx')
    expect(syntaxLangOf('/etc/my.cnf')).toBe('ini')
    expect(syntaxLangOf('/etc/systemd/system/app.service')).toBe('ini')
    expect(syntaxLangOf('/srv/app/.env.production')).toBe('ini')
    expect(syntaxLangOf('D:\\x\\deploy.sh')).toBe('shell')
    expect(syntaxLangOf('/root/.bashrc')).toBe('shell')
    expect(syntaxLangOf('/srv/Dockerfile')).toBe('dockerfile')
    expect(syntaxLangOf('/k8s/app.yaml')).toBe('yaml')
    expect(syntaxLangOf('/srv/pom.xml')).toBe('xml')
    expect(syntaxLangOf('/srv/main.go')).toBe('code')
    expect(syntaxLangOf('/srv/a.log')).toBe('plain')
  })
})

describe('tokenizeLine', () => {
  it('拼回去和原行一字不差（各语言、各种奇怪输入）', () => {
    const samples = ['', ' ', 'a', '#', '"', "'unterminated", '"esc \\" quote"', 'key = "v" # c', '[sec]', 'server { listen 80; }', 'a: b # c', '- name: x', '{"a": 1, "b": [true, null]}',
      '<a href="x">t</a> <!-- c', 'FROM node:20 AS build', 'SELECT * FROM t -- c', 'x = 1 /* c */ y // z', 'def f(): """doc"""', '$HOME ${A:-b} $1 $@', '中文 值 = 测试 # 注释', '\t\tindent', 'a#b http://x/#y', '`tmpl ${x}`']
    for (const lang of LANGS) for (const s of samples) {
      const { toks } = tokenizeLine(s, lang)
      expect(toks.map((t) => t.text).join(''), `${lang}: ${s}`).toBe(s)
    }
  })
  it('shell：注释 / 字符串 / 变量 / 关键字；a#b 不是注释', () => {
    expect(kinds(tokenizeLine('if [ "$X" = 1 ]; then echo $HOME # done', 'shell').toks)).toEqual(['keyword:if', 'string:"$X"', 'number:1', 'keyword:then', 'variable:$HOME', 'comment:# done'])
    expect(kinds(tokenizeLine('curl http://a/#frag', 'shell').toks)).toEqual([])
  })
  it('ini / systemd：段落、键、注释', () => {
    expect(kinds(tokenizeLine('[Service]', 'ini').toks)).toEqual(['section:[Service]'])
    expect(kinds(tokenizeLine('ExecStart=/usr/bin/app --port 8080', 'ini').toks)).toEqual(['key:ExecStart', 'number:8080'])
    expect(kinds(tokenizeLine('; comment', 'ini').toks)).toEqual(['comment:; comment'])
  })
  it('nginx：指令名是键，变量、数字、注释', () => {
    expect(kinds(tokenizeLine('    proxy_set_header Host $host; # keep', 'nginx').toks)).toEqual(['key:proxy_set_header', 'variable:$host', 'comment:# keep'])
    expect(kinds(tokenizeLine('listen 443 ssl;', 'nginx').toks)).toEqual(['key:listen', 'number:443'])
    expect(kinds(tokenizeLine('error_page 404 /404.html;', 'nginx').toks)).toEqual(['key:error_page', 'number:404'])
    expect(kinds(tokenizeLine('listen [::]:80;', 'nginx').toks)).toEqual(['key:listen'])
  })
  it('yaml：键、布尔、列表项里的键', () => {
    expect(kinds(tokenizeLine('  - name: web # c', 'yaml').toks)).toEqual(['key:name', 'comment:# c'])
    expect(kinds(tokenizeLine('enabled: true', 'yaml').toks)).toEqual(['key:enabled', 'keyword:true'])
    expect(kinds(tokenizeLine('image: "nginx:1.25"', 'yaml').toks)).toEqual(['key:image', 'string:"nginx:1.25"'])
  })
  it('json：键和字符串值分开', () => {
    expect(kinds(tokenizeLine('  "port": 8080, "host": "x"', 'json').toks)).toEqual(['key:"port"', 'number:8080', 'key:"host"', 'string:"x"'])
  })
  it('块注释跨行（代码、xml）', () => {
    const r = highlightText('a /* x\ny\nz */ b', 'code')
    expect(r.map(kinds)).toEqual([['comment:/* x'], ['comment:y'], ['comment:z */']])
    const x = highlightText('<a/> <!-- x\n y -->\n<b c="d">', 'xml')
    expect(x.map(kinds)).toEqual([['tag:<a', 'tag:>', 'comment:<!-- x'], ['comment: y -->'], ['tag:<b', 'key:c', 'string:"d"', 'tag:>']])
  })
  it('dockerfile：指令只在行首；sql 关键字不区分大小写', () => {
    expect(kinds(tokenizeLine('FROM node:20 AS build', 'dockerfile').toks)).toEqual(['keyword:FROM', 'keyword:AS'])
    expect(kinds(tokenizeLine('RUN echo FROM', 'dockerfile').toks)).toEqual(['keyword:RUN'])
    expect(kinds(tokenizeLine("select id from t where a = 'x' -- c", 'sql').toks)).toEqual(['keyword:select', 'keyword:from', 'keyword:where', "string:'x'", 'comment:-- c'])
  })
  it('太大的文本不高亮', () => {
    const big = 'a = 1\n'.repeat(60_000)
    expect(highlightText(big, 'ini').every((l) => l.every((t) => !t.kind))).toBe(true)
  })
})
