import Foundation
import PDFKit
import CoreGraphics

private let outlineRemovalInfoKeys: Set<String> = [
    "Title", "Author", "Subject", "Creator", "Producer", "CreationDate", "ModDate", "Keywords",
]
private let outlineRemovalPageKeys: Set<String> = [
    "Type", "Parent", "MediaBox", "CropBox", "BleedBox", "TrimBox", "ArtBox", "Rotate",
    "Resources", "Contents", "Annots",
]

func outlineMutationDocumentSnapshotIsStrict(_ document: PDFDocument) -> MetadataInventory? {
    guard let documentRef = document.documentRef,
          let catalog = documentRef.catalog,
          dictionaryContainsOnlyKeys(catalog, allowed: ["Type", "Pages", "Outlines", "Version"])
    else { return nil }
    for pageNumber in 1...document.pageCount {
        guard let page = documentRef.page(at: pageNumber)?.dictionary,
              dictionaryContainsOnlyKeys(page, allowed: outlineRemovalPageKeys)
        else { return nil }
    }
    let observed = metadata(document)
    guard let info = documentRef.info else { return observed }
    var keys: [String] = []
    var keysValid = true
    CGPDFDictionaryApplyBlock(info, { key, _, _ in
        let name = String(cString: key)
        guard outlineRemovalInfoKeys.contains(name) else {
            keysValid = false
            return false
        }
        keys.append(name)
        return true
    }, nil)
    guard keysValid else { return nil }
    let values: [String: String?] = [
        "Title": observed.title,
        "Author": observed.author,
        "Subject": observed.subject,
        "Creator": observed.creator,
        "Producer": observed.producer,
        "CreationDate": observed.creationDate,
        "ModDate": observed.modificationDate,
        "Keywords": observed.keywords,
    ]
    for key in keys {
        var raw: CGPDFStringRef?
        let copied = key.withCString { CGPDFDictionaryGetString(info, $0, &raw) }
        guard copied,
              let raw,
              let text = CGPDFStringCopyTextString(raw) as String?,
              text.utf8.count <= maximumStringLength,
              values[key] != nil
        else { return nil }
    }
    return observed
}

func outlineMutationRenderSHA256(_ document: PDFDocument, pageIndex: Int) -> String? {
    guard let documentRef = document.documentRef,
          let page = documentRef.page(at: pageIndex + 1),
          let context = CGContext(
              data: nil,
              width: 256,
              height: 256,
              bitsPerComponent: 8,
              bytesPerRow: 256 * 4,
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          )
    else { return nil }
    let target = CGRect(x: 0, y: 0, width: 256, height: 256)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(target)
    context.concatenate(
        page.getDrawingTransform(.mediaBox, rect: target, rotate: 0, preserveAspectRatio: true)
    )
    context.drawPDFPage(page)
    guard let bytes = context.data else { return nil }
    return sha256Hex(Data(bytes: bytes, count: 256 * 256 * 4))
}

func outlineMutationTextSHA256(_ text: String?) -> String {
    var data = Data(text == nil ? [0] : [1])
    if let text { data.append(Data(text.utf8)) }
    return sha256Hex(data)
}

func outlineMutationSnapshot(
    limits: Limits,
    document: PDFDocument,
    inputData: Data,
    sourceDigest: String,
    locator: OutlineRemovalLocator
) -> OutlineMutationSnapshot? {
    guard !document.isEncrypted,
          !document.isLocked,
          document.allowsDocumentChanges,
          isWithin(document.pageCount, 1, limits.maxPages),
          inputData.range(of: Data("/ByteRange".utf8)) == nil
    else { return nil }
    guard let metadata = outlineMutationDocumentSnapshotIsStrict(document),
          rawLocalGoToGraphIsSafe(document, limits: limits),
          let annotations = passiveAnnotationDescriptors(document, limits: limits),
          let outline = outlineRemovalBlueprint(document, limits: limits),
          let expected = outline.locator(
              sourceDigest: sourceDigest,
              topLevelIndex: locator.topLevelIndex
          ),
          expected.fingerprint == locator.fingerprint
    else { return nil }
    var boxes: [PageBoxes] = []
    var rotations: [Int] = []
    var texts: [String] = []
    var renders: [String] = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              let render = outlineMutationRenderSHA256(document, pageIndex: pageIndex)
        else { return nil }
        boxes.append(localGoToPageBoxes(page))
        rotations.append(page.rotation)
        texts.append(outlineMutationTextSHA256(page.string))
        renders.append(render)
    }
    return OutlineMutationSnapshot(
        pageCount: document.pageCount,
        pageBoxes: boxes,
        pageRotations: rotations,
        annotationDescriptors: annotations,
        textSHA256: texts,
        renderSHA256: renders,
        metadata: metadata,
        outline: outline
    )
}

func verifiesOutlineMutation(
    limits: Limits,
    document: PDFDocument,
    snapshot: OutlineMutationSnapshot,
    expectedOutline: OutlineRemovalBlueprint
) -> Bool {
    guard !document.isEncrypted,
          !document.isLocked,
          document.pageCount == snapshot.pageCount
    else { return false }
    guard outlineMutationDocumentSnapshotIsStrict(document) == snapshot.metadata,
          rawLocalGoToGraphIsSafe(document, limits: limits),
          let annotations = passiveAnnotationDescriptors(document, limits: limits),
          annotations == snapshot.annotationDescriptors,
          let outline = outlineRemovalBlueprint(document, limits: limits),
          outline == expectedOutline
    else { return false }
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              let render = outlineMutationRenderSHA256(document, pageIndex: pageIndex),
              localGoToPageBoxes(page) == snapshot.pageBoxes[pageIndex],
              page.rotation == snapshot.pageRotations[pageIndex],
              outlineMutationTextSHA256(page.string) == snapshot.textSHA256[pageIndex],
              render == snapshot.renderSHA256[pageIndex]
        else { return false }
    }
    return true
}
