describe('GcpVertexAccountService auth credentials handling', () => {
  const plaintextServiceAccountJson = JSON.stringify({
    project_id: 'project-1',
    private_key: 'test-key',
    client_email: 'test@example.com'
  })

  const loadServiceWithMocks = ({ decryptImpl }) => {
    jest.resetModules()

    const decrypt = jest.fn(decryptImpl)
    const encrypt = jest.fn((value) => value)

    const googleAuthInstances = []

    jest.doMock('../src/utils/commonHelper', () => ({
      createEncryptor: jest.fn(() => ({
        decrypt,
        encrypt
      }))
    }))

    jest.doMock('google-auth-library', () => ({
      GoogleAuth: jest.fn().mockImplementation((options) => {
        googleAuthInstances.push(options)
        return {
          getClient: async () => ({
            getAccessToken: async () => ({ token: 'vertex-token' })
          })
        }
      })
    }))

    const service = require('../src/services/account/gcpVertexAccountService')
    return { service, decrypt, googleAuthInstances }
  }

  it('does not decrypt when serviceAccountJson is already plaintext JSON', async () => {
    const { service, decrypt, googleAuthInstances } = loadServiceWithMocks({
      decryptImpl: (value) => value
    })

    const account = {
      id: 'account-1',
      serviceAccountJson: plaintextServiceAccountJson,
      proxy: null
    }

    const token = await service.getAccessToken(account)

    expect(token).toBe('vertex-token')
    expect(decrypt).not.toHaveBeenCalled()
    expect(googleAuthInstances).toHaveLength(1)
    expect(googleAuthInstances[0].credentials).toEqual(JSON.parse(plaintextServiceAccountJson))
  })

  it('decrypts when serviceAccountJson is encrypted-looking input', async () => {
    const { service, decrypt, googleAuthInstances } = loadServiceWithMocks({
      decryptImpl: () => plaintextServiceAccountJson
    })

    const account = {
      id: 'account-1',
      serviceAccountJson: 'enc:blob',
      proxy: null
    }

    const token = await service.getAccessToken(account)

    expect(token).toBe('vertex-token')
    expect(decrypt).toHaveBeenCalledTimes(1)
    expect(decrypt).toHaveBeenCalledWith('enc:blob')
    expect(googleAuthInstances).toHaveLength(1)
    expect(googleAuthInstances[0].credentials).toEqual(JSON.parse(plaintextServiceAccountJson))
  })
})

