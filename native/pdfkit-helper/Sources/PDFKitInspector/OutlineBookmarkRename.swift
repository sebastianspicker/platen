import Foundation
import PDFKit

func renameOutlineBookmark(
    _ request: OutlineBookmarkRenameRequest, workspace: URL, inputData: Data
) throws -> OutlineBookmarkRenameReceipt {
    let sourceDigest = sha256Hex(inputData)
    let locator = OutlineRemovalLocator(
        topLevelIndex: request.bookmarkRename.topLevelIndex,
        fingerprint: request.bookmarkRename.fingerprint
    )
    guard request.sourceSha256 == sourceDigest, let document = PDFDocument(data: inputData),
          let snapshot = outlineMutationSnapshot(
              limits: request.limits, document: document, inputData: inputData, sourceDigest: sourceDigest, locator: locator
          ),
          request.bookmarkRename.topLevelIndex < snapshot.outline.nodes.count,
          snapshot.outline.nodes[request.bookmarkRename.topLevelIndex].label != request.bookmarkRename.label,
          let root = document.outlineRoot,
          let target = root.child(at: request.bookmarkRename.topLevelIndex), target.numberOfChildren == 0
    else { throw InspectionFailure.mutationFailed }

    var expectedNodes = snapshot.outline.nodes
    let prior = expectedNodes[request.bookmarkRename.topLevelIndex]
    expectedNodes[request.bookmarkRename.topLevelIndex] = OutlineRemovalNode(
        label: request.bookmarkRename.label,
        labelSHA256: sha256Hex(Data(request.bookmarkRename.label.utf8)),
        isOpen: prior.isOpen,
        destination: prior.destination,
        children: prior.children
    )
    let expected = OutlineRemovalBlueprint(nodes: expectedNodes, itemCount: snapshot.outline.itemCount)
    target.label = request.bookmarkRename.label
    guard let serializedData = document.dataRepresentation(),
          let outputData = restoreInjectedInfoDates(in: serializedData, from: inputData),
          outputData.count <= maxOutputBytes, outputData != inputData,
          let candidate = PDFDocument(data: outputData),
          verifiesOutlineMutation(limits: request.limits, document: candidate, snapshot: snapshot, expectedOutline: expected)
    else { throw InspectionFailure.mutationFailed }

    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let unchangedInput = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename))
    let reopenedData = try readPrivateInput(output)
    guard unchangedInput == inputData, reopenedData == outputData,
          let reopened = PDFDocument(data: reopenedData),
          verifiesOutlineMutation(limits: request.limits, document: reopened, snapshot: snapshot, expectedOutline: expected)
    else { throw InspectionFailure.outputInvalid }

    let outputDigest = sha256Hex(reopenedData)
    guard outputDigest != sourceDigest else { throw InspectionFailure.outputInvalid }
    return OutlineBookmarkRenameReceipt(
        sourceSha256: sourceDigest,
        outputSha256: outputDigest,
        topLevelIndex: request.bookmarkRename.topLevelIndex,
        labelSha256: sha256Hex(Data(request.bookmarkRename.label.utf8)),
        pageCount: reopened.pageCount
    )
}
