import Foundation
import PDFKit
import AppKit
import Darwin
import CryptoKit
import CoreGraphics

struct ProtectionPostflightSnapshot: Equatable {
    let pageBoxes: [PageBoxes]
    let pageRotations: [Int]
    let annotationCounts: [Int]
    let annotationSubtypes: [[String]]
    let annotationDescriptors: [[CropAnnotationDescriptor]]
    let metadata: ProtectionStableMetadata
    let outline: OutlineInventory
    let extractedTextSHA256: [String]
    let renderRGBA256SHA256: [String]
}

struct ProtectionStableMetadata: Equatable {
    let title: String?
    let author: String?
    let subject: String?
    let creator: String?
    let keywords: String?
}

func protectionStableMetadata(_ document: PDFDocument) -> ProtectionStableMetadata {
    let values = metadata(document)
    return ProtectionStableMetadata(
        title: values.title, author: values.author, subject: values.subject,
        creator: values.creator, keywords: values.keywords
    )
}

private func renderRGBA256SHA256(_ document: PDFDocument, pageIndex: Int) -> String? {
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
    context.concatenate(page.getDrawingTransform(.mediaBox, rect: target, rotate: 0, preserveAspectRatio: true))
    context.drawPDFPage(page)
    guard let bytes = context.data else { return nil }
    return sha256Hex(Data(bytes: bytes, count: 256 * 256 * 4))
}

func protectionPostflightSnapshot(_ document: PDFDocument, limits: Limits) -> ProtectionPostflightSnapshot? {
    guard let structure = protectionStructure(document, limits: limits) else { return nil }
    var pageBoxes: [PageBoxes] = []
    var annotationDescriptors: [[CropAnnotationDescriptor]] = []
    var textHashes: [String] = []
    var renderHashes: [String] = []
    pageBoxes.reserveCapacity(document.pageCount)
    annotationDescriptors.reserveCapacity(document.pageCount)
    textHashes.reserveCapacity(document.pageCount)
    renderHashes.reserveCapacity(document.pageCount)
    let descriptorBudget = RawDescriptorTraversalBudget()
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex), let text = page.string,
              let descriptors = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget),
              let renderHash = renderRGBA256SHA256(document, pageIndex: pageIndex)
        else { return nil }
        pageBoxes.append(PageBoxes(
            media: rectangle(page.bounds(for: .mediaBox)), crop: rectangle(page.bounds(for: .cropBox)),
            bleed: rectangle(page.bounds(for: .bleedBox)), trim: rectangle(page.bounds(for: .trimBox)),
            art: rectangle(page.bounds(for: .artBox))
        ))
        annotationDescriptors.append(descriptors)
        textHashes.append(sha256Hex(Data(text.utf8)))
        renderHashes.append(renderHash)
    }
    return ProtectionPostflightSnapshot(
        pageBoxes: pageBoxes,
        pageRotations: structure.pageRotations,
        annotationCounts: structure.annotationCounts,
        annotationSubtypes: structure.annotationSubtypes,
        annotationDescriptors: annotationDescriptors,
        metadata: protectionStableMetadata(document),
        outline: inspectOutline(document, limits: limits),
        extractedTextSHA256: textHashes,
        renderRGBA256SHA256: renderHashes
    )
}

struct ProtectionPermissionProfile {
    let mask: Int
    let pdfPermissionValue: Int
    let names: [String]
    let copying: Bool
    let printing: Bool
    let changes: Bool
    let commenting: Bool
    let formFieldEntry: Bool
    let assembly: Bool
    let contentAccessibility: Bool
}

func protectionPermissionProfile(named name: String) -> ProtectionPermissionProfile? {
    switch name {
    case "accessibility-only":
        return ProtectionPermissionProfile(
            mask: Int(PDFAccessPermissions.allowsContentAccessibility.rawValue),
            pdfPermissionValue: -3392,
            names: ["contentAccessibility"],
            copying: false, printing: false, changes: false, commenting: false,
            formFieldEntry: false, assembly: false, contentAccessibility: true
        )
    case "copy-accessibility":
        return ProtectionPermissionProfile(
            mask: Int(
                PDFAccessPermissions.allowsContentCopying.rawValue
                    | PDFAccessPermissions.allowsContentAccessibility.rawValue
            ),
            pdfPermissionValue: -3376,
            names: ["copying", "contentAccessibility"],
            copying: true, printing: false, changes: false, commenting: false,
            formFieldEntry: false, assembly: false, contentAccessibility: true
        )
    case "deny-all":
        return ProtectionPermissionProfile(
            mask: 0, pdfPermissionValue: -3904, names: [],
            copying: false, printing: false, changes: false, commenting: false,
            formFieldEntry: false, assembly: false, contentAccessibility: false
        )
    case "print-only":
        return ProtectionPermissionProfile(
            mask: Int(
                PDFAccessPermissions.allowsLowQualityPrinting.rawValue
                    | PDFAccessPermissions.allowsHighQualityPrinting.rawValue
            ),
            pdfPermissionValue: -1852,
            names: ["printing"],
            copying: false, printing: true, changes: false, commenting: false,
            formFieldEntry: false, assembly: false, contentAccessibility: false
        )
    default:
        return nil
    }
}

private func userPermissionsMatch(_ document: PDFDocument, profile: ProtectionPermissionProfile) -> Bool {
    guard document.permissionsStatus == .user,
          Int(document.accessPermissions.rawValue) == profile.mask
    else { return false }
    return document.allowsCopying == profile.copying
        && document.allowsPrinting == profile.printing
        && document.allowsDocumentChanges == profile.changes
        && document.allowsCommenting == profile.commenting
        && document.allowsFormFieldEntry == profile.formFieldEntry
        && document.allowsDocumentAssembly == profile.assembly
        && document.allowsContentAccessibility == profile.contentAccessibility
}

func usesExpectedAES128Encryption(_ data: Data, profile: ProtectionPermissionProfile) -> Bool {
    [
        "/Filter /Standard", "/V 4", "/R 4", "/Length 128", "/CFM /AESV2",
        "/StmF /StdCF", "/StrF /StdCF", "/P \(profile.pdfPermissionValue)",
    ].allSatisfy {
        data.range(of: Data($0.utf8)) != nil
    }
}

func protect(
    _ request: ProtectionRequest,
    workspace: URL,
    inputData: Data
) throws -> ProtectionReceipt {
    let sourceSha256 = sha256Hex(inputData)
    guard let permissionProfile = protectionPermissionProfile(named: request.protection.profile),
          request.sourceSha256 == sourceSha256,
          let document = PDFDocument(data: inputData),
          !document.isEncrypted, !document.isLocked,
          !documentHasActionsOrSignatureWidgets(document),
          !catalogContainsProhibitedProtectionContent(document),
          let inputStructure = protectionStructure(document, limits: request.limits),
          let inputPostflight = protectionPostflightSnapshot(document, limits: request.limits)
    else { throw InspectionFailure.mutationFailed }

    let options: [PDFDocumentWriteOption: Any] = [
        .ownerPasswordOption: request.protection.ownerPassword,
        .userPasswordOption: request.protection.userPassword,
        .accessPermissionsOption: NSNumber(value: permissionProfile.mask),
    ]
    guard let outputData = document.dataRepresentation(options: options), outputData.count <= maxOutputBytes else {
        throw InspectionFailure.mutationFailed
    }
    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    let wrongPassword = String(repeating: "x", count: 33)
    guard usesExpectedAES128Encryption(reopenedData, profile: permissionProfile),
          let locked = PDFDocument(data: reopenedData), locked.isEncrypted, locked.isLocked,
          !locked.unlock(withPassword: wrongPassword), locked.isLocked,
          let user = PDFDocument(data: reopenedData), user.unlock(withPassword: request.protection.userPassword),
          userPermissionsMatch(user, profile: permissionProfile),
          let owner = PDFDocument(data: reopenedData), owner.unlock(withPassword: request.protection.ownerPassword),
          owner.permissionsStatus == .owner,
          let outputStructure = protectionStructure(owner, limits: request.limits), outputStructure == inputStructure,
          let outputPostflight = protectionPostflightSnapshot(owner, limits: request.limits), outputPostflight == inputPostflight
    else { throw InspectionFailure.outputInvalid }

    return ProtectionReceipt(
        sourceSha256: sourceSha256,
        outputSha256: sha256Hex(reopenedData),
        profile: request.protection.profile,
        effectivePermissions: permissionProfile.names,
        effectivePermissionMask: permissionProfile.mask,
        pageCount: owner.pageCount,
        structuralSummary: outputStructure
    )
}
