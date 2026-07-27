import Foundation

func strictSigningRequest(from data: Data) throws -> SigningRequest {
    guard data.count <= maxSigningRequestBytes else { throw SigningFailure.requestTooLarge }
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let version = object["version"] as? NSNumber,
          CFGetTypeID(version) != CFBooleanGetTypeID(),
          version.intValue == signingProtocolVersion,
          let operation = object["operation"] as? String
    else { throw SigningFailure.invalidRequest }
    let allowed: Set<String>
    switch operation {
    case "listSigningIdentities":
        allowed = ["version", "operation"]
    case "createDetachedCMS":
        allowed = ["version", "operation", "inputFilename", "inputSha256", "certificateSha256"]
    case "verifyDetachedCMS":
        allowed = ["version", "operation", "inputFilename", "inputSha256", "cmsFilename", "cmsSha256", "certificateSha256"]
    default:
        throw SigningFailure.invalidRequest
    }
    guard Set(object.keys) == allowed else { throw SigningFailure.invalidRequest }
    let request: SigningRequest
    do { request = try JSONDecoder().decode(SigningRequest.self, from: data) }
    catch { throw SigningFailure.invalidRequest }
    guard request.version == signingProtocolVersion, request.operation == operation else {
        throw SigningFailure.invalidRequest
    }
    if operation == "createDetachedCMS" {
        guard request.inputFilename == signingInputFilename,
              request.inputSha256.map(isLowercaseSHA256) == true,
              request.certificateSha256.map(isLowercaseSHA256) == true
        else { throw SigningFailure.invalidRequest }
    } else if operation == "verifyDetachedCMS" {
        guard request.inputFilename == signingVerifyInputFilename,
              request.inputSha256.map(isLowercaseSHA256) == true,
              request.cmsFilename == signingVerifyCmsFilename,
              request.cmsSha256.map(isLowercaseSHA256) == true,
              request.certificateSha256.map(isLowercaseSHA256) == true
        else { throw SigningFailure.invalidRequest }
    } else if request.inputFilename != nil || request.inputSha256 != nil || request.certificateSha256 != nil || request.cmsFilename != nil || request.cmsSha256 != nil {
        throw SigningFailure.invalidRequest
    }
    return request
}
