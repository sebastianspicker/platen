import Foundation
import LocalAuthentication
import Security

struct SigningIdentity {
    let identity: SecIdentity
    let certificateSha256: String
    let certificateBytes: Int
}

func nonInteractiveIdentityQuery() -> [CFString: Any] {
    let authenticationContext = LAContext()
    authenticationContext.interactionNotAllowed = true
    return [
        kSecClass: kSecClassIdentity,
        kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnRef: true,
        kSecUseAuthenticationContext: authenticationContext
    ]
}

private func identityObjects() throws -> [SecIdentity] {
    let query = nonInteractiveIdentityQuery()
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else { throw SigningFailure.platformDenied }
    if let identities = result as? [SecIdentity] { return identities }
    if let result, CFGetTypeID(result) == SecIdentityGetTypeID() {
        return [unsafeBitCast(result, to: SecIdentity.self)]
    }
    throw SigningFailure.platformDenied
}

func usableSigningIdentities() throws -> [SigningIdentity] {
    var output: [SigningIdentity] = []
    for identity in try identityObjects() {
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess,
              let certificate
        else { continue }
        let bytes = SecCertificateCopyData(certificate) as Data
        guard !bytes.isEmpty, bytes.count <= 65_536 else { continue }
        output.append(SigningIdentity(
            identity: identity,
            certificateSha256: sha256Hex(bytes),
            certificateBytes: bytes.count
        ))
    }
    return output.sorted { $0.certificateSha256 < $1.certificateSha256 }
}

func createDetachedCMS(_ content: Data, identity: SigningIdentity) throws -> Data {
    func failure(_ status: OSStatus) -> SigningFailure {
        [errSecInteractionNotAllowed, errSecAuthFailed, errSecUserCanceled].contains(status)
            ? .platformDenied : .cmsFailed
    }
    var encoder: CMSEncoder?
    let createStatus = CMSEncoderCreate(&encoder)
    guard createStatus == errSecSuccess, let encoder else { throw failure(createStatus) }
    let setupStatuses = [
        CMSEncoderSetSignerAlgorithm(encoder, kCMSEncoderDigestAlgorithmSHA256),
        CMSEncoderAddSigners(encoder, identity.identity),
        CMSEncoderSetHasDetachedContent(encoder, true)
    ]
    guard let setupFailure = setupStatuses.first(where: { $0 != errSecSuccess }) else {
        let updateStatus = content.withUnsafeBytes { rawBuffer -> OSStatus in
            CMSEncoderUpdateContent(encoder, rawBuffer.baseAddress!, content.count)
        }
        guard updateStatus == errSecSuccess else { throw failure(updateStatus) }
        var encoded: CFData?
        let copyStatus = CMSEncoderCopyEncodedContent(encoder, &encoded)
        guard copyStatus == errSecSuccess, let encoded else { throw failure(copyStatus) }
        return encoded as Data
    }
    throw failure(setupFailure)
}
