import Foundation
import PDFScannerAcquisitionCore

private func writeEnvelope(_ envelope: ScannerEnvelope) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(envelope) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func writeScanEnvelope(_ envelope: ScannerScanEnvelope) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(envelope) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func writeDuplexEnvelope(_ envelope: ScannerDuplexEnvelope) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(envelope) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func errorEnvelope(_ code: String, reason: String = "The scanner request was rejected.") -> ScannerEnvelope {
    ScannerEnvelope(ok: false, error: ScannerUnsupportedResult(code: code, reason: reason, evidence: ScannerEvidence(discoveryAttempted: false)))
}

private func process(_ frame: ScannerFramedLine) {
    guard case .line(let data) = frame else {
        writeEnvelope(errorEnvelope("SCANNER_REQUEST_TOO_LARGE"))
        return
    }
    guard !data.isEmpty else {
        writeEnvelope(errorEnvelope("SCANNER_INVALID_REQUEST"))
        return
    }
    do {
        switch try parseScannerRequest(data) {
        case .list:
            writeEnvelope(ScannerEnvelope(ok: true, result: discoverScanners()))
        case .scan(let request):
            guard validatePrivateDestination(URL(fileURLWithPath: request.destination)) else {
                writeScanEnvelope(unsupportedAcquisitionEnvelope(code: "SCANNER_DESTINATION_INVALID", reason: "The trusted workspace must already exist as a private non-symlink directory."))
                return
            }
            do {
                writeScanEnvelope(ScannerScanEnvelope(ok: true, result: try acquireScannerPage(request)))
            } catch ScannerProtocolError.invalidDestination {
                writeScanEnvelope(unsupportedAcquisitionEnvelope(code: "SCANNER_DESTINATION_INVALID", reason: "The trusted workspace must already exist as a private non-symlink directory."))
            } catch ScannerProtocolError.scanUnsupported {
                writeScanEnvelope(unsupportedAcquisitionEnvelope())
            } catch {
                writeScanEnvelope(unsupportedAcquisitionEnvelope(code: "SCANNER_SCAN_FAILED", reason: "The scanner did not complete the bounded acquisition."))
            }
        case .scanDuplex(let request):
            guard validatePrivateDestination(URL(fileURLWithPath: request.destination)) else {
                writeDuplexEnvelope(unsupportedDuplexEnvelope(
                    code: "SCANNER_DESTINATION_INVALID",
                    reason: "The trusted workspace must already exist as a private non-symlink directory."
                ))
                return
            }
            do {
                writeDuplexEnvelope(ScannerDuplexEnvelope(ok: true, result: try acquireScannerDuplex(request)))
            } catch ScannerProtocolError.invalidDestination {
                writeDuplexEnvelope(unsupportedDuplexEnvelope(
                    code: "SCANNER_DESTINATION_INVALID",
                    reason: "The trusted workspace must already exist as a private non-symlink directory."
                ))
            } catch ScannerProtocolError.scanUnsupported {
                writeDuplexEnvelope(unsupportedDuplexEnvelope())
            } catch {
                writeDuplexEnvelope(unsupportedDuplexEnvelope(
                    code: "SCANNER_DUPLEX_FAILED",
                    reason: "The scanner did not complete the exact bounded duplex feeder acquisition."
                ))
            }
        }
    } catch ScannerProtocolError.requestTooLarge {
        writeEnvelope(errorEnvelope("SCANNER_REQUEST_TOO_LARGE"))
    } catch ScannerProtocolError.invalidDestination {
        writeEnvelope(errorEnvelope("SCANNER_DESTINATION_INVALID"))
    } catch {
        writeEnvelope(errorEnvelope("SCANNER_INVALID_REQUEST"))
    }
}

var framer = ScannerLineFramer()
while let chunk = try? FileHandle.standardInput.read(upToCount: 4 * 1024), !chunk.isEmpty {
    for frame in framer.append(chunk) { autoreleasepool { process(frame) } }
}
for frame in framer.finish() { autoreleasepool { process(frame) } }
