import Foundation

private func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value), data.count <= maxSigningResponseBytes else {
        FileHandle.standardOutput.write(Data("{\"version\":1,\"ok\":false,\"error\":{\"code\":\"RESPONSE_TOO_LARGE\"}}\n".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func main() {
    guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--request" else {
        emit(SigningError(error: SigningErrorBody(code: SigningFailure.invalidRequest.code)))
        return
    }
    do {
        let (workspace, requestURL) = try validatedSigningWorkspace(requestPath: CommandLine.arguments[2])
        let requestData = try readPrivateSigningFile(requestURL, maximumBytes: maxSigningRequestBytes)
        let request = try strictSigningRequest(from: requestData)
        switch request.operation {
        case "listSigningIdentities":
            let identities = try usableSigningIdentities().map {
                CertificateReceipt(certificateSha256: $0.certificateSha256, certificateBytes: $0.certificateBytes)
            }
            emit(SigningSuccess(result: SigningListResult(identities: identities)))
        case "createDetachedCMS":
            let identities = try usableSigningIdentities()
            guard let certificateSha256 = request.certificateSha256,
                  let identity = identities.first(where: { $0.certificateSha256 == certificateSha256 })
            else { throw SigningFailure.identityNotFound }
            let input = try readPrivateSigningFile(
                workspace.appendingPathComponent(signingInputFilename), maximumBytes: maxSigningInputBytes
            )
            guard let inputSha256 = request.inputSha256, sha256Hex(input) == inputSha256 else {
                throw SigningFailure.sourceDigestMismatch
            }
            let cms = try createDetachedCMS(input, identity: identity)
            try writePrivateCMS(cms, workspace: workspace)
            let receipt = SigningCMSResult(
                certificateSha256: identity.certificateSha256,
                inputSha256: inputSha256,
                cmsSha256: sha256Hex(cms), cmsBytes: cms.count, outputFilename: signingOutputFilename
            )
            emit(SigningSuccess(result: receipt))
        case "verifyDetachedCMS":
            let input = try readPrivateSigningFile(workspace.appendingPathComponent(signingVerifyInputFilename), maximumBytes: maxSigningInputBytes)
            let cms = try readPrivateSigningFile(workspace.appendingPathComponent(signingVerifyCmsFilename), maximumBytes: maxSigningCMSBytes)
            guard let inputSha256 = request.inputSha256, sha256Hex(input) == inputSha256,
                  let cmsSha256 = request.cmsSha256, sha256Hex(cms) == cmsSha256,
                  let certificateSha256 = request.certificateSha256
            else { throw SigningFailure.sourceDigestMismatch }
            let verification = try verifyDetachedCMS(input: input, cms: cms, expectedCertificateSha256: certificateSha256)
            emit(SigningSuccess(result: VerifyCMSResult(inputSha256: inputSha256, cmsSha256: cmsSha256, certificateSha256: verification.certificateSha256, signatureValid: verification.signatureValid, trustStatus: verification.trustStatus, trustReason: verification.trustReason)))
        default:
            throw SigningFailure.invalidRequest
        }
    } catch let failure as SigningFailure {
        emit(SigningError(error: SigningErrorBody(code: failure.code)))
    } catch {
        emit(SigningError(error: SigningErrorBody(code: SigningFailure.invalidRequest.code)))
    }
}

main()
