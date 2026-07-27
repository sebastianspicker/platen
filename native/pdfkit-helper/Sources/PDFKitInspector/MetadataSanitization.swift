import Foundation
import PDFKit
import CoreGraphics

private let metadataInfoKeys: Set<String> = [
    "Title", "Author", "Subject", "Creator", "Producer", "CreationDate", "ModDate", "Keywords",
]
private let metadataPageKeys: Set<String> = [
    "Type", "Parent", "MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox", "Rotate",
    "Resources", "Contents", "Annots",
]

private struct MetadataOutlineNode {
    let label: String; let isOpen: Bool; let pageIndex: Int; let point: CGPoint; let zoom: CGFloat
    let usesGoToAction: Bool; let children: [MetadataOutlineNode]
}

private struct MetadataContentSnapshot: Equatable {
    let pageBoxes: [PageBoxes]; let pageRotations: [Int]; let annotationDescriptors: [[CropAnnotationDescriptor]]
    let outline: OutlineInventory; let extractedTextSHA256: [String]; let renderRGBA256SHA256: [String]
}

private func metadataDestinationValueIsSafe(_ value: CGFloat) -> Bool {
    let number = Double(value); let unspecified = Double(Float.greatestFiniteMagnitude)
    return number.isFinite && (abs(number) <= maximumCoordinate || number == unspecified)
}

private func metadataCatalogIsStrict(_ document: PDFDocument, allowingMetadata: Bool, allowingVersion: Bool) -> Bool {
    guard let catalog = document.documentRef?.catalog, pdfName(catalog, key: "Type") == "Catalog",
          dictionaryContainsOnlyKeys(catalog, allowed: allowingMetadata
              ? (allowingVersion ? ["Type", "Pages", "Outlines", "Version", "Metadata"] : ["Type", "Pages", "Outlines", "Metadata"])
              : (allowingVersion ? ["Type", "Pages", "Outlines", "Version"] : ["Type", "Pages", "Outlines"]))
    else { return false }
    var pages: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(catalog, "Pages", &pages), pages != nil else { return false }
    if dictionaryContainsObject(catalog, key: "Outlines") {
        var outlines: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(catalog, "Outlines", &outlines), outlines != nil else { return false }
    }
    if dictionaryContainsObject(catalog, key: "Metadata") {
        var metadata: CGPDFStreamRef?
        guard allowingMetadata, CGPDFDictionaryGetStream(catalog, "Metadata", &metadata), metadata != nil else { return false }
    }
    return !dictionaryContainsObject(catalog, key: "Version") || allowingVersion && pdfName(catalog, key: "Version") != nil
}

private func metadataPagesAreStrictAndPassive(_ document: PDFDocument, limits: Limits) -> Bool {
    guard isWithin(document.pageCount, 1, limits.maxPages), let documentRef = document.documentRef else { return false }
    for pageNumber in 1...document.pageCount {
        guard let page = document.page(at: pageNumber - 1), page.annotations.count <= limits.maxAnnotationsPerPage,
              let dictionary = documentRef.page(at: pageNumber)?.dictionary, pdfName(dictionary, key: "Type") == "Page",
              dictionaryContainsOnlyKeys(dictionary, allowed: metadataPageKeys),
              !["Metadata", "StructParents", "PieceInfo", "AF", "AA", "PresSteps", "Dur", "Trans"].contains(where: {
                  dictionaryContainsObject(dictionary, key: $0)
              })
        else { return false }
    }
    return true
}

private func metadataInfoCategories(_ document: PDFDocument) -> [String]? {
    guard let info = document.documentRef?.info else { return [] }
    var keys: [String] = []; var valid = true
    CGPDFDictionaryApplyBlock(info, { key, _, _ in
        let name = String(cString: key)
        guard name.utf8.count <= maximumStringLength else { valid = false; return false }
        keys.append(name); return true
    }, nil)
    guard valid else { return nil }
    var categories: [String] = []
    if keys.contains(where: metadataInfoKeys.contains) { categories.append("document-info") }
    if keys.contains(where: { !metadataInfoKeys.contains($0) }) { categories.append("custom-info") }
    return categories
}

private func metadataAbsent(_ document: PDFDocument) -> Bool {
    let values = metadata(document)
    guard [values.title, values.author, values.subject, values.creator, values.producer,
           values.creationDate, values.modificationDate, values.keywords].allSatisfy({ $0 == nil }),
          let catalog = document.documentRef?.catalog, !dictionaryContainsObject(catalog, key: "Metadata")
    else { return false }
    guard let info = document.documentRef?.info else { return true }
    var count = 0
    CGPDFDictionaryApplyBlock(info, { _, _, _ in count += 1; return true }, nil)
    return count == 0
}

private func metadataOutlineBlueprint(_ document: PDFDocument, limits: Limits) -> [MetadataOutlineNode]? {
    guard let policies = rawOutlinePolicies(document, limits: limits) else { return nil }
    guard let root = document.outlineRoot else { return policies.isEmpty ? [] : nil }
    var itemCount = 0
    func children(of parent: PDFOutline, depth: Int, prefix: String) -> [MetadataOutlineNode]? {
        guard depth < limits.maxOutlineDepth || parent.numberOfChildren == 0 else { return nil }
        var result: [MetadataOutlineNode] = []
        for index in 0..<parent.numberOfChildren {
            guard itemCount < limits.maxOutlineItems, let item = parent.child(at: index) else { return nil }
            itemCount += 1; let path = prefix.isEmpty ? String(index) : "\(prefix).\(index)"
            guard let policy = policies[path], let label = item.label, label == policy.title,
                  isWithin(label.utf8.count, 1, maximumStringLength) else { return nil }
            let destination: PDFDestination; let usesGoToAction: Bool
            switch policy.action {
            case .directDestination: guard let direct = item.destination else { return nil }; destination = direct; usesGoToAction = false
            case .goToAction: guard let action = item.action as? PDFActionGoTo else { return nil }; destination = action.destination; usesGoToAction = true
            case .unsafe: return nil
            }
            guard let page = destination.page else { return nil }
            let pageIndex = document.index(for: page); let point = destination.point; let zoom = destination.zoom
            guard pageIndex != NSNotFound, pageIndex >= 0, pageIndex < document.pageCount,
                  metadataDestinationValueIsSafe(point.x), metadataDestinationValueIsSafe(point.y), metadataDestinationValueIsSafe(zoom),
                  let nested = children(of: item, depth: depth + 1, prefix: path) else { return nil }
            result.append(MetadataOutlineNode(label: label, isOpen: item.isOpen, pageIndex: pageIndex, point: point,
                                              zoom: zoom, usesGoToAction: usesGoToAction, children: nested))
        }
        return result
    }
    guard let result = children(of: root, depth: 0, prefix: ""), itemCount == policies.count else { return nil }
    return result
}

private func installMetadataOutline(_ nodes: [MetadataOutlineNode], in document: PDFDocument) -> Bool {
    guard !nodes.isEmpty else { return true }
    let root = PDFOutline()
    func append(_ entries: [MetadataOutlineNode], to parent: PDFOutline) -> Bool {
        for entry in entries {
            guard let page = document.page(at: entry.pageIndex) else { return false }
            let destination = PDFDestination(page: page, at: entry.point); destination.zoom = entry.zoom
            let item = PDFOutline(); item.label = entry.label; item.isOpen = entry.isOpen
            if entry.usesGoToAction { item.action = PDFActionGoTo(destination: destination) } else { item.destination = destination }
            guard append(entry.children, to: item) else { return false }
            parent.insertChild(item, at: parent.numberOfChildren)
        }
        return true
    }
    guard append(nodes, to: root) else { return false }; document.outlineRoot = root; return true
}

private func metadataRenderRGBA256SHA256(_ document: PDFDocument, pageIndex: Int) -> String? {
    guard let page = document.documentRef?.page(at: pageIndex + 1), let context = CGContext(
        data: nil, width: 256, height: 256, bitsPerComponent: 8, bytesPerRow: 256 * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    let target = CGRect(x: 0, y: 0, width: 256, height: 256)
    context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(target)
    context.concatenate(page.getDrawingTransform(.mediaBox, rect: target, rotate: 0, preserveAspectRatio: true)); context.drawPDFPage(page)
    guard let bytes = context.data else { return nil }
    return sha256Hex(Data(bytes: bytes, count: 256 * 256 * 4))
}

private func metadataContentSnapshot(_ document: PDFDocument, limits: Limits) -> MetadataContentSnapshot? {
    guard isWithin(document.pageCount, 1, limits.maxPages), let descriptors = passiveAnnotationDescriptors(document, limits: limits),
          metadataOutlineBlueprint(document, limits: limits) != nil else { return nil }
    var boxes: [PageBoxes] = []; var rotations: [Int] = []; var textHashes: [String] = []; var renderHashes: [String] = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex), let text = page.string,
              let renderHash = metadataRenderRGBA256SHA256(document, pageIndex: pageIndex) else { return nil }
        boxes.append(PageBoxes(media: rectangle(page.bounds(for: .mediaBox)), crop: rectangle(page.bounds(for: .cropBox)),
                               bleed: rectangle(page.bounds(for: .bleedBox)), trim: rectangle(page.bounds(for: .trimBox)), art: rectangle(page.bounds(for: .artBox))))
        rotations.append(page.rotation); textHashes.append(sha256Hex(Data(text.utf8))); renderHashes.append(renderHash)
    }
    return MetadataContentSnapshot(pageBoxes: boxes, pageRotations: rotations, annotationDescriptors: descriptors,
                                   outline: inspectOutline(document, limits: limits), extractedTextSHA256: textHashes,
                                   renderRGBA256SHA256: renderHashes)
}

func sanitizeMetadata(_ request: MetadataSanitizationRequest, workspace: URL, inputData: Data) throws -> MetadataSanitizationReceipt {
    let sourceSha256 = sha256Hex(inputData)
    guard request.sourceSha256 == sourceSha256, let source = PDFDocument(data: inputData), !source.isEncrypted, !source.isLocked,
          !documentHasActionsOrSignatureWidgets(source), !documentHasWidgets(source), !rawPagesContainActions(source),
          metadataCatalogIsStrict(source, allowingMetadata: true, allowingVersion: true), metadataPagesAreStrictAndPassive(source, limits: request.limits),
          let sourceInfoCategories = metadataInfoCategories(source), let sourceOutline = metadataOutlineBlueprint(source, limits: request.limits),
          let sourceSnapshot = metadataContentSnapshot(source, limits: request.limits)
    else { throw InspectionFailure.mutationFailed }
    var observedCategories = sourceInfoCategories
    if let catalog = source.documentRef?.catalog, dictionaryContainsObject(catalog, key: "Metadata") { observedCategories.append("xmp") }
    guard !observedCategories.isEmpty else { throw InspectionFailure.mutationFailed }
    let target = PDFDocument()
    for pageIndex in 0..<source.pageCount {
        guard let page = source.page(at: pageIndex), let copy = page.copy() as? PDFPage else { throw InspectionFailure.mutationFailed }
        target.insert(copy, at: pageIndex)
    }
    target.documentAttributes = [:]
    guard installMetadataOutline(sourceOutline, in: target), let written = target.dataRepresentation(), written.count <= maxOutputBytes,
          let outputData = removeInjectedInfoDictionary(from: written), outputData.count == written.count, outputData != inputData
    else { throw InspectionFailure.mutationFailed }
    let output = workspace.appendingPathComponent(request.outputFilename); try writePrivateOutput(outputData, to: output)
    let unchangedInput = try readPrivateInput(workspace.appendingPathComponent(request.inputFilename)); let reopenedData = try readPrivateInput(output)
    guard unchangedInput == inputData, reopenedData == outputData, let reopened = PDFDocument(data: reopenedData), !reopened.isEncrypted, !reopened.isLocked,
          metadataCatalogIsStrict(reopened, allowingMetadata: false, allowingVersion: false), metadataPagesAreStrictAndPassive(reopened, limits: request.limits),
          !documentHasActionsOrSignatureWidgets(reopened), !documentHasWidgets(reopened), !rawPagesContainActions(reopened), metadataAbsent(reopened),
          let outputSnapshot = metadataContentSnapshot(reopened, limits: request.limits), outputSnapshot == sourceSnapshot
    else { throw InspectionFailure.outputInvalid }
    return MetadataSanitizationReceipt(sourceSha256: sourceSha256, outputSha256: sha256Hex(reopenedData), pageCount: reopened.pageCount,
                                       observedCategories: observedCategories)
}
