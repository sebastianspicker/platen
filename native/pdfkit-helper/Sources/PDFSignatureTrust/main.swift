import Foundation

private func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value), data.count <= maxTrustResponseBytes else {
        FileHandle.standardOutput.write(Data("{\"version\":1,\"ok\":false,\"error\":{\"code\":\"RESPONSE_TOO_LARGE\"}}\n".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func canonicalUTC(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
}

private func detachedContent(from pdf: Data, byteRange: [Int64]) throws -> Data {
    guard byteRange.count == 4,
          byteRange[0] == 0,
          byteRange[1] > 0,
          byteRange[2] > byteRange[1],
          byteRange[3] > 0,
          byteRange[2] <= Int64(pdf.count),
          byteRange[3] <= Int64(pdf.count) - byteRange[2]
    else { throw TrustFailure.invalidRequest }

    let firstEnd = Int(byteRange[1])
    let secondStart = Int(byteRange[2])
    let secondEnd = secondStart + Int(byteRange[3])
    var detached = Data()
    detached.reserveCapacity(firstEnd + (secondEnd - secondStart))
    detached.append(contentsOf: pdf[..<firstEnd])
    detached.append(contentsOf: pdf[secondStart..<secondEnd])
    return detached
}

private func main() {
    guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--request" else {
        emit(TrustError(error: TrustErrorBody(code: TrustFailure.invalidRequest.code)))
        return
    }
    do {
        let workspace = try validatedTrustWorkspace(requestPath: CommandLine.arguments[2])
        let requestData = try readPrivateTrustFile(
            workspace.request, maximumBytes: maxTrustRequestBytes, emptyAllowed: false, oversize: .requestTooLarge
        )
        let request = try strictTrustRequest(from: requestData)
        let input = workspace.workspace.appendingPathComponent(request.inputFilename)
        let pdf = try readPrivateTrustFile(
            input, maximumBytes: fixedLimits.maxPdfBytes, emptyAllowed: false, oversize: .inputTooLarge
        )
        let digest = trustSHA256(pdf)
        guard digest == request.sourceSha256 else { throw TrustFailure.sourceDigestMismatch }
        let evaluationTime = Date()
        var totalCMSBytes = 0
        var seenRanges = Set<String>()
        let records = try request.records.enumerated().map { index, record -> SignatureRecord in
            let rangeKey = record.byteRange.map(String.init).joined(separator: ":")
            guard seenRanges.insert(rangeKey).inserted else { throw TrustFailure.invalidRequest }
            let detached = try detachedContent(from: pdf, byteRange: record.byteRange)
            let cms = try readPrivateCMSDump(
                workspace: workspace.workspace, index: index, maximumBytes: fixedLimits.maxCmsBytesPerSignature
            )
            guard trustSHA256(cms) == record.cmsSha256 else { throw TrustFailure.sourceDigestMismatch }
            guard cms.count <= fixedLimits.maxCmsBytesTotal - totalCMSBytes else { throw TrustFailure.resourceLimit }
            totalCMSBytes += cms.count
            let chain = evaluateCertificateChain(
                contents: cms,
                detachedContent: detached,
                subFilter: record.subFilter,
                limits: fixedLimits,
                evaluationTime: evaluationTime
            )
            return SignatureRecord(
                byteRange: record.byteRange,
                subFilter: record.subFilter,
                cmsSha256: record.cmsSha256,
                certificateChain: chain
            )
        }
        emit(TrustSuccess(result: TrustReceipt(sourceSha256: digest, evaluatedAt: canonicalUTC(evaluationTime), records: records)))
    } catch let failure as TrustFailure {
        emit(TrustError(error: TrustErrorBody(code: failure.code)))
    } catch {
        emit(TrustError(error: TrustErrorBody(code: TrustFailure.invalidRequest.code)))
    }
}

main()
