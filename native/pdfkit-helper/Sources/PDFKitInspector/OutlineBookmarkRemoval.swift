import Foundation
import PDFKit

func removeOutlineBookmark(
    _ request: OutlineBookmarkRemovalRequest,
    workspace: URL,
    inputData: Data
) throws -> OutlineBookmarkRemovalReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard request.sourceSha256 == sourceDigest,
          let document = PDFDocument(data: inputData),
          let snapshot = outlineMutationSnapshot(
              limits: request.limits,
              document: document,
              inputData: inputData,
              sourceDigest: sourceDigest,
              locator: OutlineRemovalLocator(
                  topLevelIndex: request.bookmark.topLevelIndex,
                  fingerprint: request.bookmark.fingerprint
              )
          ),
          request.bookmark.topLevelIndex < snapshot.outline.nodes.count
    else { throw InspectionFailure.mutationFailed }
    var remaining = snapshot.outline.nodes
    remaining.remove(at: request.bookmark.topLevelIndex)
    let expected = OutlineRemovalBlueprint(
        nodes: remaining,
        itemCount: snapshot.outline.itemCount - 1
    )
    let root = PDFOutline()
    guard installOutlineMutationNodes(remaining, in: root, document: document) else {
        throw InspectionFailure.mutationFailed
    }
    document.outlineRoot = root
    guard let serializedData = document.dataRepresentation(),
          let outputData = restoreInjectedInfoDates(in: serializedData, from: inputData),
          outputData.count <= maxOutputBytes,
          outputData != inputData,
          let candidate = PDFDocument(data: outputData),
          verifiesOutlineMutation(
              limits: request.limits,
              document: candidate,
              snapshot: snapshot,
              expectedOutline: expected
          )
    else { throw InspectionFailure.mutationFailed }

    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let unchangedInput = try readPrivateInput(
        workspace.appendingPathComponent(request.inputFilename)
    )
    let reopenedData = try readPrivateInput(output)
    guard unchangedInput == inputData,
          reopenedData == outputData,
          let reopened = PDFDocument(data: reopenedData),
          verifiesOutlineMutation(
              limits: request.limits,
              document: reopened,
              snapshot: snapshot,
              expectedOutline: expected
          )
    else { throw InspectionFailure.outputInvalid }
    let outputDigest = sha256Hex(reopenedData)
    guard outputDigest != sourceDigest else { throw InspectionFailure.outputInvalid }
    return OutlineBookmarkRemovalReceipt(
        sourceSha256: sourceDigest,
        outputSha256: outputDigest,
        topLevelIndex: request.bookmark.topLevelIndex,
        pageCount: reopened.pageCount
    )
}
