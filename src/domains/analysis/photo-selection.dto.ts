import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
export class SelectPhotoDto {
  @ApiProperty({
    format: 'uuid',
    description: 'original 또는 elements에서 선택한 elementId 한 개',
  })
  @IsUUID('4')
  elementId!: string;
}

export interface PhotoSelectionMetadata {
  selectionType?: 'ORIGINAL' | 'PHOTO_REGION';
  uploadId: string;
  elementId: string;
  bbox: { left: number; top: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
  coordinateSpace: 'NORMALIZED_IMAGE';
  preprocessingVersion: string;
}

export class PhotoBoxDto {
  @ApiProperty({ minimum: 0 }) left!: number;
  @ApiProperty({ minimum: 0 }) top!: number;
  @ApiProperty({ minimum: 32 }) width!: number;
  @ApiProperty({ minimum: 32 }) height!: number;
}
export class PhotoCandidateDto {
  @ApiProperty({ enum: ['ORIGINAL', 'PHOTO_REGION'] }) type!:
    'ORIGINAL' | 'PHOTO_REGION';
  @ApiProperty({ format: 'uuid' }) elementId!: string;
  @ApiProperty({ type: PhotoBoxDto }) bbox!: PhotoBoxDto;
}
export class PhotoImageDto {
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
  @ApiProperty({ enum: ['NORMALIZED_IMAGE'] }) coordinateSpace!: string;
}
export class PhotoUploadDto {
  @ApiProperty({ format: 'uuid' }) uploadId!: string;
  @ApiProperty({ enum: ['AWAITING_SELECTION', 'NO_CANDIDATES'] })
  status!: string;
  @ApiProperty({ type: PhotoImageDto }) image!: PhotoImageDto;
  @ApiProperty({ example: 'gemini-photo-regions-v1' })
  detectorVersion!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({
    type: PhotoCandidateDto,
    description: '전체 이미지 분석 선택지. 사진 후보가 없어도 제공.',
  })
  original!: PhotoCandidateDto;
  @ApiProperty({ type: [PhotoCandidateDto] }) elements!: PhotoCandidateDto[];
}
export class PhotoUploadResponseDto {
  @ApiProperty() isSuccess!: boolean;
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ type: PhotoUploadDto }) result!: PhotoUploadDto;
}
