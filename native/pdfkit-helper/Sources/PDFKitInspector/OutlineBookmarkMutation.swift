import Foundation
import PDFKit
import CoreGraphics

private struct OutlineBookmarkNode: Equatable {
    let label: String
    let isOpen: Bool
    let pageIndex: Int
    let point: CGPoint
    let zoom: CGFloat
    let children: [OutlineBookmarkNode]
}

private struct OutlineBookmarkSnapshot {
    let pageCount: Int
    let pageBoxes: [PageBoxes]
    let rotations: [Int]
    let annotations: [[CropAnnotationDescriptor]]
    let outline: [OutlineBookmarkNode]
    let outlineItemCount: Int
}

private func outlineBookmarkDestinationIsSafe(_ destination: PDFDestination, in document: PDFDocument) -> Bool {
    guard let page = destination.page else { return false }
    let pageIndex = document.index(for: page)
    let values = [destination.point.x, destination.point.y, destination.zoom].map(Double.init)
    return pageIndex != NSNotFound && pageIndex >= 0 && pageIndex < document.pageCount
        && values.allSatisfy { value in
            value.isFinite && (abs(value) <= maximumCoordinate || value == Double(Float.greatestFiniteMagnitude))
        }
}

private func outlineBookmarkBlueprint(_ document: PDFDocument, limits: Limits) -> ([OutlineBookmarkNode], Int)? {
    guard let policies = rawOutlinePolicies(document, limits: limits) else { return nil }
    guard let root = document.outlineRoot else { return policies.isEmpty ? ([], 0) : nil }
    var itemCount = 0
    func children(of parent: PDFOutline, depth: Int, prefix: String) -> [OutlineBookmarkNode]? {
        guard depth < limits.maxOutlineDepth || parent.numberOfChildren == 0 else { return nil }
        var result: [OutlineBookmarkNode] = []
        for index in 0..<parent.numberOfChildren {
            guard itemCount < limits.maxOutlineItems, let item = parent.child(at: index) else { return nil }
            itemCount += 1
            let path = prefix.isEmpty ? String(index) : "\(prefix).\(index)"
            guard let policy = policies[path], case .directDestination = policy.action,
                  let label = item.label, label == policy.title, label.utf8.count <= maximumStringLength,
                  let destination = item.destination,
                  outlineBookmarkDestinationIsSafe(destination, in: document),
                  let page = destination.page, let nested = children(of: item, depth: depth + 1, prefix: path)
            else { return nil }
            let pageIndex = document.index(for: page)
            result.append(OutlineBookmarkNode(label: label, isOpen: item.isOpen, pageIndex: pageIndex,
                                               point: destination.point, zoom: destination.zoom, children: nested))
        }
        return result
    }
    guard let result = children(of: root, depth: 0, prefix: ""), itemCount == policies.count else { return nil }
    return (result, itemCount)
}

private func outlineBookmarkSnapshot(
    _ request: OutlineBookmarkRequest, document: PDFDocument, inputData: Data
) -> OutlineBookmarkSnapshot? {
    guard !document.isEncrypted, !document.isLocked, document.allowsDocumentChanges,
          document.pageCount >= 1, document.pageCount <= request.limits.maxPages,
          request.bookmark.page <= document.pageCount,
          inputData.range(of: Data("/ByteRange".utf8)) == nil,
          rawLocalGoToGraphIsSafe(document, limits: request.limits),
          let annotations = passiveAnnotationDescriptors(document, limits: request.limits),
          let (outline, outlineItemCount) = outlineBookmarkBlueprint(document, limits: request.limits),
          outlineItemCount < request.limits.maxOutlineItems
    else { return nil }
    var boxes: [PageBoxes] = []; var rotations: [Int] = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex) else { return nil }
        boxes.append(localGoToPageBoxes(page)); rotations.append(page.rotation)
    }
    return OutlineBookmarkSnapshot(pageCount: document.pageCount, pageBoxes: boxes, rotations: rotations,
                                   annotations: annotations, outline: outline, outlineItemCount: outlineItemCount)
}

private func rawOutlineBookmarkDestinationMatches(
    _ document: PDFDocument, topLevelIndex: Int, expected: RawLocalGoToDestination
) -> Bool {
    guard let documentRef = document.documentRef, let catalog = documentRef.catalog else { return false }
    var root: CGPDFDictionaryRef?; var item: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(catalog, "Outlines", &root), let root,
          CGPDFDictionaryGetDictionary(root, "First", &item) else { return false }
    for _ in 0..<topLevelIndex {
        var next: CGPDFDictionaryRef?
        guard let current = item, CGPDFDictionaryGetDictionary(current, "Next", &next) else { return false }
        item = next
    }
    var destination: CGPDFArrayRef?
    guard let item, CGPDFDictionaryGetArray(item, "Dest", &destination), let destination else { return false }
    return rawLocalGoToDestination(destination, document: documentRef) == expected
}

private func verifiesOutlineBookmark(
    _ request: OutlineBookmarkRequest, document: PDFDocument, snapshot: OutlineBookmarkSnapshot
) -> Bool {
    guard !document.isEncrypted, !document.isLocked, document.pageCount == snapshot.pageCount,
          let annotations = passiveAnnotationDescriptors(document, limits: request.limits), annotations == snapshot.annotations,
          let (outline, count) = outlineBookmarkBlueprint(document, limits: request.limits),
          count == snapshot.outlineItemCount + 1, outline.count == snapshot.outline.count + 1,
          Array(outline.dropLast()) == snapshot.outline,
          let appended = outline.last, appended.label == request.bookmark.label, !appended.isOpen,
          appended.children.isEmpty, appended.pageIndex == request.bookmark.page - 1,
          let page = document.page(at: request.bookmark.page - 1),
          closeEnough(appended.point, CGPoint(x: page.bounds(for: .cropBox).minX, y: page.bounds(for: .cropBox).maxY)),
          appended.zoom == CGFloat(Float.greatestFiniteMagnitude),
          rawOutlinePolicies(document, limits: request.limits)?.values.allSatisfy({ policy in
              if case .directDestination = policy.action { return true }; return false
          }) == true,
          rawOutlineBookmarkDestinationMatches(document, topLevelIndex: snapshot.outline.count,
                                               expected: RawLocalGoToDestination(page: request.bookmark.page,
                                                                                  x: page.bounds(for: .cropBox).minX,
                                                                                  y: page.bounds(for: .cropBox).maxY))
    else { return false }
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex), localGoToPageBoxes(page) == snapshot.pageBoxes[pageIndex],
              page.rotation == snapshot.rotations[pageIndex] else { return false }
    }
    return true
}

func appendOutlineBookmark(
    _ request: OutlineBookmarkRequest, workspace: URL, inputData: Data
) throws -> OutlineBookmarkReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard sourceDigest == request.sourceSha256, let document = PDFDocument(data: inputData),
          let snapshot = outlineBookmarkSnapshot(request, document: document, inputData: inputData),
          let target = document.page(at: request.bookmark.page - 1)
    else { throw InspectionFailure.mutationFailed }
    let root = document.outlineRoot ?? PDFOutline()
    let item = PDFOutline(); item.label = request.bookmark.label; item.isOpen = false
    item.destination = PDFDestination(page: target, at: CGPoint(x: target.bounds(for: .cropBox).minX,
                                                                  y: target.bounds(for: .cropBox).maxY))
    root.insertChild(item, at: root.numberOfChildren); document.outlineRoot = root
    guard let outputData = document.dataRepresentation(), outputData.count <= maxOutputBytes,
          let candidate = PDFDocument(data: outputData), verifiesOutlineBookmark(request, document: candidate, snapshot: snapshot)
    else { throw InspectionFailure.mutationFailed }
    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    guard let reopened = PDFDocument(data: reopenedData), verifiesOutlineBookmark(request, document: reopened, snapshot: snapshot) else {
        throw InspectionFailure.outputInvalid
    }
    let outputDigest = sha256Hex(reopenedData)
    guard outputDigest != sourceDigest else { throw InspectionFailure.outputInvalid }
    return OutlineBookmarkReceipt(sourceSha256: sourceDigest, outputSha256: outputDigest,
                                  labelSha256: sha256Hex(Data(request.bookmark.label.utf8)),
                                  page: request.bookmark.page, pageCount: reopened.pageCount)
}
