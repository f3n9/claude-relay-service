const {
  normalizeBridgeRoutingRules,
  parseBridgeRoutingRules
} = require('../src/utils/bridgeRoutingRules')

describe('bridgeRoutingRules utility', () => {
  it('normalizes complete rules and filters invalid entries', () => {
    expect(
      normalizeBridgeRoutingRules([
        {
          sourceModel: ' deepseek-v4-flash ',
          bridgeAccountId: ' bridge-1 ',
          targetModel: ' DeepSeek-V4-Flash ',
          enabled: 'false'
        },
        {
          sourceModel: 'kimi-k2.6',
          bridgeAccountId: 'bridge-2',
          targetModel: 'Kimi-K2.6'
        },
        {
          sourceModel: 'missing-target',
          bridgeAccountId: 'bridge-3',
          targetModel: ''
        },
        null
      ])
    ).toEqual([
      {
        sourceModel: 'deepseek-v4-flash',
        bridgeAccountId: 'bridge-1',
        targetModel: 'DeepSeek-V4-Flash',
        enabled: false
      },
      {
        sourceModel: 'kimi-k2.6',
        bridgeAccountId: 'bridge-2',
        targetModel: 'Kimi-K2.6',
        enabled: true
      }
    ])
  })

  it('parses stored JSON and returns an empty list for malformed values', () => {
    expect(
      parseBridgeRoutingRules(
        JSON.stringify([
          {
            sourceModel: 'grok-4.3',
            bridgeAccountId: 'bridge-3',
            targetModel: 'grok-4.3',
            enabled: true
          }
        ])
      )
    ).toEqual([
      {
        sourceModel: 'grok-4.3',
        bridgeAccountId: 'bridge-3',
        targetModel: 'grok-4.3',
        enabled: true
      }
    ])

    expect(parseBridgeRoutingRules('{bad json')).toEqual([])
    expect(parseBridgeRoutingRules({ sourceModel: 'not-array' })).toEqual([])
  })
})
