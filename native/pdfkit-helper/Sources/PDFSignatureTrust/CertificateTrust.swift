import Foundation
import Security

private func malformed() -> CertificateChain {
    CertificateChain(status: "indeterminate", reason: "malformed-cms", chainLength: nil)
}

private func unsupported(_ reason: String) -> CertificateChain {
    CertificateChain(status: "unsupported", reason: reason, chainLength: nil)
}

private func indeterminate(_ reason: String) -> CertificateChain {
    CertificateChain(status: "indeterminate", reason: reason, chainLength: nil)
}

private func trustReason(_ error: CFError?) -> String {
    guard let error else { return "not-trusted" }
    let code = CFErrorGetCode(error)
    if code == errSecCertificateExpired { return "expired" }
    if code == errSecCertificateNotValidYet { return "not-yet-valid" }
    if code == errSecTrustSettingDeny { return "explicitly-denied" }
    if code == errSecNotTrusted { return "not-trusted" }
    return "policy-failure"
}

func evaluateCertificateChain(
    contents: Data,
    detachedContent: Data,
    subFilter: String?,
    limits: TrustLimits,
    evaluationTime: Date
) -> CertificateChain {
    guard subFilter == "adbe.pkcs7.detached" || subFilter == "ETSI.CAdES.detached" else {
        return unsupported("unsupported-subfilter")
    }
    let cms: Data
    do { cms = try frameCMSBER(contents, limits: limits) }
    catch BERFramingFailure.resourceLimit { return indeterminate("resource-limit") }
    catch { return malformed() }

    var decoder: CMSDecoder?
    guard CMSDecoderCreate(&decoder) == errSecSuccess, let decoder,
          CMSDecoderSetDetachedContent(decoder, detachedContent as CFData) == errSecSuccess
    else { return indeterminate("platform-error") }
    let updateStatus = cms.withUnsafeBytes { CMSDecoderUpdateMessage(decoder, $0.baseAddress!, cms.count) }
    guard updateStatus == errSecSuccess, CMSDecoderFinalizeMessage(decoder) == errSecSuccess else { return malformed() }

    var signerCount = 0
    guard CMSDecoderGetNumSigners(decoder, &signerCount) == errSecSuccess else { return malformed() }
    guard signerCount == 1 else { return indeterminate("multiple-cms-signers") }

    let signaturePolicy = SecPolicyCreateBasicX509()
    var signerStatus = CMSSignerStatus.unsigned
    var temporaryTrust: SecTrust?
    guard CMSDecoderCopySignerStatus(
        decoder, 0, signaturePolicy, false, &signerStatus, &temporaryTrust, nil
    ) == errSecSuccess, temporaryTrust != nil
    else { return indeterminate("platform-error") }
    guard signerStatus == .valid else { return indeterminate("cms-signature-mismatch") }

    var signer: SecCertificate?
    guard CMSDecoderCopySignerCert(decoder, 0, &signer) == errSecSuccess, let signer else {
        return indeterminate("missing-embedded-signer-certificate")
    }
    var copiedCertificates: CFArray?
    guard CMSDecoderCopyAllCerts(decoder, &copiedCertificates) == errSecSuccess,
          let certificates = copiedCertificates as? [SecCertificate]
    else { return indeterminate("platform-error") }
    guard certificates.count <= limits.maxCertificatesPerSignature else { return indeterminate("resource-limit") }

    var embedded = Set<Data>()
    var uniqueCertificates: [SecCertificate] = []
    for certificate in certificates {
        let data = SecCertificateCopyData(certificate) as Data
        guard data.count <= limits.maxCertificateBytes else { return indeterminate("resource-limit") }
        if embedded.insert(data).inserted { uniqueCertificates.append(certificate) }
    }
    let signerData = SecCertificateCopyData(signer) as Data
    guard signerData.count <= limits.maxCertificateBytes,
          embedded.contains(signerData)
    else { return indeterminate("missing-embedded-signer-certificate") }

    let orderedCertificates = [signer] + uniqueCertificates.filter { SecCertificateCopyData($0) as Data != signerData }
    let pathPolicy = SecPolicyCreateBasicX509()
    var trust: SecTrust?
    guard SecTrustCreateWithCertificates(orderedCertificates as CFArray, pathPolicy, &trust) == errSecSuccess,
          let trust,
          SecTrustSetVerifyDate(trust, evaluationTime as CFDate) == errSecSuccess,
          SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess
    else { return indeterminate("platform-error") }

    var networkFetchAllowed = DarwinBoolean(true)
    guard SecTrustGetNetworkFetchAllowed(trust, &networkFetchAllowed) == errSecSuccess,
          networkFetchAllowed.boolValue == false
    else { return indeterminate("platform-error") }

    var error: CFError?
    let passed = SecTrustEvaluateWithError(trust, &error)
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], !chain.isEmpty,
          chain.count <= limits.maxCertificatesPerSignature
    else { return indeterminate("platform-error") }
    for (index, certificate) in chain.enumerated() {
        let data = SecCertificateCopyData(certificate) as Data
        guard data.count <= limits.maxCertificateBytes else { return indeterminate("resource-limit") }
        if index < chain.count - 1 && !embedded.contains(data) { return indeterminate("platform-error") }
    }
    if !passed { return CertificateChain(status: "fails", reason: trustReason(error), chainLength: chain.count) }
    return CertificateChain(status: "passes", reason: "none", chainLength: chain.count)
}
