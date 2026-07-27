import Foundation
import Security

struct DetachedCMSVerification {
    let certificateSha256: String
    let signatureValid: Bool
    let trustStatus: String
    let trustReason: String
}

private let maxVerificationCertificates = 16
private let maxVerificationCertificateBytes = 65_536

func verifyDetachedCMS(input: Data, cms: Data, expectedCertificateSha256: String) throws -> DetachedCMSVerification {
    var decoder: CMSDecoder?
    guard CMSDecoderCreate(&decoder) == errSecSuccess, let decoder,
          CMSDecoderSetDetachedContent(decoder, input as CFData) == errSecSuccess
    else { throw SigningFailure.trustIndeterminate }
    let update = cms.withUnsafeBytes { rawBuffer -> OSStatus in
        guard let baseAddress = rawBuffer.baseAddress else { return errSecDecode }
        return CMSDecoderUpdateMessage(decoder, baseAddress, cms.count)
    }
    guard update == errSecSuccess, CMSDecoderFinalizeMessage(decoder) == errSecSuccess else { throw SigningFailure.cmsInvalid }
    var signerCount = 0
    guard CMSDecoderGetNumSigners(decoder, &signerCount) == errSecSuccess else { throw SigningFailure.cmsInvalid }
    guard signerCount == 1 else { throw SigningFailure.cmsMultipleSigners }
    var status = CMSSignerStatus.unsigned
    guard CMSDecoderCopySignerStatus(decoder, 0, SecPolicyCreateBasicX509(), false, &status, nil, nil) == errSecSuccess else { throw SigningFailure.trustIndeterminate }
    guard status == .valid else { throw SigningFailure.cmsInvalid }
    var signer: SecCertificate?
    guard CMSDecoderCopySignerCert(decoder, 0, &signer) == errSecSuccess, let signer else { throw SigningFailure.cmsInvalid }
    let signerData = SecCertificateCopyData(signer) as Data
    guard signerData.count <= maxVerificationCertificateBytes else { throw SigningFailure.trustIndeterminate }
    let certificateSha256 = sha256Hex(signerData)
    guard certificateSha256 == expectedCertificateSha256 else { throw SigningFailure.identityNotFound }
    var copiedCertificates: CFArray?
    guard CMSDecoderCopyAllCerts(decoder, &copiedCertificates) == errSecSuccess,
          let allCertificates = copiedCertificates as? [SecCertificate],
          allCertificates.count <= maxVerificationCertificates
    else { throw SigningFailure.trustIndeterminate }
    var signerOccurrences = 0
    var seen = Set<Data>()
    var uniqueCertificates: [SecCertificate] = []
    for certificate in allCertificates {
        let data = SecCertificateCopyData(certificate) as Data
        guard data.count <= maxVerificationCertificateBytes else { throw SigningFailure.trustIndeterminate }
        if data == signerData { signerOccurrences += 1 }
        if seen.insert(data).inserted { uniqueCertificates.append(certificate) }
    }
    guard signerOccurrences == 1, seen.contains(signerData) else { throw SigningFailure.trustIndeterminate }
    let orderedCertificates = [signer] + uniqueCertificates.filter { (SecCertificateCopyData($0) as Data) != signerData }
    var trust: SecTrust?
    guard SecTrustCreateWithCertificates(orderedCertificates as CFArray, SecPolicyCreateBasicX509(), &trust) == errSecSuccess,
          let trust,
          SecTrustSetVerifyDate(trust, Date() as CFDate) == errSecSuccess,
          SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess
    else { throw SigningFailure.trustIndeterminate }
    var networkFetch = DarwinBoolean(true)
    guard SecTrustGetNetworkFetchAllowed(trust, &networkFetch) == errSecSuccess, !networkFetch.boolValue else { throw SigningFailure.trustIndeterminate }
    var trustError: CFError?
    let trusted = SecTrustEvaluateWithError(trust, &trustError)
    let reason: String
    if trusted { reason = "none" }
    else if let trustError, CFErrorGetCode(trustError) == errSecCertificateExpired { reason = "expired" }
    else if let trustError, CFErrorGetCode(trustError) == errSecCertificateNotValidYet { reason = "not-yet-valid" }
    else if let trustError, CFErrorGetCode(trustError) == errSecTrustSettingDeny { reason = "explicitly-denied" }
    else { reason = "not-trusted" }
    return DetachedCMSVerification(certificateSha256: certificateSha256, signatureValid: true, trustStatus: trusted ? "passes" : "fails", trustReason: reason)
}
