const fs = require('fs')
const path = require('path')

describe('Claude OpenAI bridge account form model mapping cleanup', () => {
  const accountFormPath = path.join(
    __dirname,
    '..',
    'web',
    'admin-spa',
    'src',
    'components',
    'accounts',
    'AccountForm.vue'
  )

  test('does not expose or require bridge-account model mappings', () => {
    const source = fs.readFileSync(accountFormPath, 'utf8')

    expect(source).not.toContain('bridgeModelMappings')
    expect(source).not.toContain('cleanBridgeMappings')
    expect(source).not.toContain('defaultBridgeMappings')
    expect(source).not.toContain('请至少配置一个模型映射')
  })
})
